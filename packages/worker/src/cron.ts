import { semanticEnv, type Config, type Env } from "./env.ts";
import { AUDIT_RETENTION_DAYS } from "./db/audit.ts";
import { SECRET_HISTORY_DAYS } from "./db/secrets.ts";
import { blobKey } from "./routes/api.ts";
import { purgeStatements } from "./db/search.ts";
import { cleanupStatements as activityCleanup, purgeActivityStatements } from "./db/activity.ts";
import { purgeLabelStatements } from "./db/labels.ts";
import { purgeAccessStatements } from "./db/access.ts";
import { presenceCleanup } from "./db/presence.ts";
import { forgetPages, indexPending, semanticOn } from "./db/semantic.ts";
import { purgeCommentStatements } from "./db/comments.ts";

/** Blobs younger than this are kept even when unreferenced: their publish may still be running. */
const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

export interface CleanupReport {
  expired: number;
  purgedArtifacts: number;
  prunedVersions: number;
  deletedBlobs: number;
  /** Pages embedded for search by meaning. */
  indexedPages: number;
}

/** Daily housekeeping. Every step is idempotent, so a failed run is simply repeated the next day. */
export async function cleanup(env: Env, config: Config, now = new Date()): Promise<CleanupReport> {
  const iso = now.toISOString();
  const db = env.DB;

  const expiredResults = await db.batch([
    db.prepare("delete from nonces where expires_at <= ?").bind(iso),
    db.prepare("delete from sessions where expires_at <= ?").bind(iso),
    db.prepare("delete from pairings where expires_at <= ?").bind(new Date(now.getTime() - 864e5).toISOString()),
    db.prepare("delete from login_links where expires_at <= ?").bind(iso),
    db.prepare("delete from invites where expires_at <= ?").bind(iso),
    db.prepare("delete from audit_events where event_at <= ?").bind(new Date(now.getTime() - AUDIT_RETENTION_DAYS * 864e5).toISOString()),
    // Secret requests: drop the ciphertext of expired ones, then forget old ones entirely.
    db.prepare("update secrets set ciphertext = null, finished_at = ?, finished_by = 'expiry' where finished_at is null and expires_at <= ?").bind(iso, iso),
    db.prepare("delete from secrets where finished_at <= ?").bind(new Date(now.getTime() - SECRET_HISTORY_DAYS * 864e5).toISOString()),
    ...activityCleanup(db, now),
    presenceCleanup(db, now),
  ]);
  const expired = expiredResults.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

  // Empty the trash.
  const cutoff = new Date(now.getTime() - config.trashDays * 864e5).toISOString();
  const doomed = await db.prepare("select id from artifacts where deleted_at is not null and deleted_at <= ?").bind(cutoff).all<{ id: string }>();
  await forgetPages(semanticEnv(env), doomed.results.map((r) => r.id));
  const purged = await db.batch([
    ...purgeStatements(db, cutoff),
    ...purgeCommentStatements(db, cutoff),
    ...purgeLabelStatements(db, cutoff),
    ...purgeAccessStatements(db, cutoff),
    ...purgeActivityStatements(db, cutoff),
    db.prepare("delete from versions where artifact_id in (select id from artifacts where deleted_at is not null and deleted_at <= ?)").bind(cutoff),
    db.prepare("delete from artifacts where deleted_at is not null and deleted_at <= ?").bind(cutoff),
  ]);
  const purgedArtifacts = purged[purged.length - 1]?.meta.changes ?? 0;

  // Keep only the newest KEEP_VERSIONS versions of each artifact (0 keeps all). The current
  // version is always the newest, so it is never pruned.
  let prunedVersions = 0;
  if (config.keepVersions > 0) {
    const r = await db
      .prepare(
        `delete from versions where rowid in (
           select rowid from (
             select rowid, row_number() over (partition by artifact_id order by version desc) as rank from versions
           ) where rank > ?
         )`,
      )
      .bind(config.keepVersions)
      .run();
    prunedVersions = r.meta.changes ?? 0;
  }

  // Delete blobs that no version references.
  const referenced = new Set<string>();
  const { results } = await db.prepare("select files from versions").all<{ files: string }>();
  for (const row of results) {
    for (const file of Object.values(JSON.parse(row.files) as Record<string, { sha256: string }>)) referenced.add(blobKey(file.sha256));
  }
  let deletedBlobs = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BLOBS.list({ prefix: "blobs/", cursor, limit: 1000 });
    const unused = page.objects
      .filter((o) => !referenced.has(o.key) && now.getTime() - o.uploaded.getTime() > BLOB_GRACE_MS)
      .map((o) => o.key);
    if (unused.length) {
      await env.BLOBS.delete(unused);
      deletedBlobs += unused.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // Search by meaning: a few of the pages not indexed yet (those from before it, or that failed).
  let indexedPages = 0;
  const semantic = semanticEnv(env);
  if (semanticOn(semantic)) {
    try {
      indexedPages = (await indexPending(semantic)).indexed;
    } catch (e) {
      console.log("semantic index", String(e));
    }
  }

  return { expired, purgedArtifacts, prunedVersions, deletedBlobs, indexedPages };
}
