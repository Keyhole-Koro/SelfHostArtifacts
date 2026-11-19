import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_VERSION,
  MAX_VERSION_BYTES,
  SHA256_HEX,
  contentTypeFor,
  hashOf,
  artifactIdSchema,
  MAX_TEXT_CHARS,
  manifestSchema,
  projectSchema,
  type MoveResponse,
  type ArtifactDetail,
  type ArtifactSummary,
  type BlobCheckResponse,
  type ListResponse,
  type ProjectListResponse,
  type SearchResponse,
  type CommentListResponse,
  type ActivityResponse,
  type LabelResponse,
  labelSchema,
  labelsSchema,
  type Manifest,
  type PairPollResponse,
  type PairStartResponse,
  type PublishResponse,
  type VersionFile,
  SECRET_DEFAULT_HOURS,
  secretCreateSchema,
  secretSealSchema,
  type SecretCreateResponse,
  type SecretListResponse,
  type SecretSummary,
} from "@artifact/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.ts";
import { requireDevice } from "../auth/device.ts";
import {
  addVersion,
  createArtifact,
  getArtifact,
  getVersion,
  listArtifacts,
  listProjectPages,
  listProjects,
  listVersions,
  placeAmongSiblings,
  setParent,
  setProject,
  subtreeOf,
  trashArtifact,
  type ArtifactRow,
} from "../db/artifacts.ts";
import { createLoginLink, createUser, firstRoot, getUser, LOGIN_LINK_SECONDS } from "../db/users.ts";
import { apiError } from "../lib/api-error.ts";
import { pairingCode, randomId, randomToken, sha256Hex } from "../lib/encoding.ts";
import { createSecret, finishSecret, getSecret, listSecrets, sealSecret, secretStatus, secretSummary } from "../db/secrets.ts";
import { safeNext } from "../lib/internal-path.ts";
import { recordAuditEvent } from "../db/audit.ts";
import { MARK_END, MARK_START, indexStatements, linkStatements, linkedFrom, linksTo } from "../db/search.ts";
import { indexLater } from "../db/semantic.ts";
import { listActivity, record } from "../db/activity.ts";
import { changeLabels, labeledSearch, labelsOf } from "../db/labels.ts";
import { passOnRestriction } from "../db/access.ts";
import { semanticEnv } from "../env.ts";
import { MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, addComment, getComment, listComments, setResolved, threadPeople } from "../db/comments.ts";

export const blobKey = (sha256: string) => `blobs/${sha256}`;

const PAIRING_MINUTES = 10;
const MAX_PENDING_PAIRINGS_PER_IP = 3;

export const api = new Hono<AppEnv>();

function artifactUrl(c: Context<AppEnv>, id: string): string {
  return `${c.get("config").origin}/a/${id}`;
}

function summary(c: Context<AppEnv>, a: ArtifactRow, allowConnect: string[], labels: string[]): ArtifactSummary {
  return {
    id: a.id,
    url: artifactUrl(c, a.id),
    title: a.title,
    description: a.description,
    project: a.project,
    parent: a.parent,
    position: a.position,
    labels,
    restriction: a.restriction ?? null,
    version: a.current_version,
    updated_at: a.updated_at,
    allow_connect: allowConnect,
  };
}

async function readJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "bad_request", "The body must be JSON.") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    return { ok: false, res: apiError(c, 400, "invalid_manifest", message) };
  }
  return { ok: true, value: parsed.data };
}

/** Looks up every file of the manifest in R2 and returns the version's file table. */
async function resolveFiles(
  c: Context<AppEnv>,
  manifest: Manifest,
): Promise<{ ok: true; files: Record<string, VersionFile> } | { ok: false; res: Response }> {
  const files: Record<string, VersionFile> = {};
  let total = 0;
  const missing: string[] = [];
  await Promise.all(
    Object.entries(manifest.files).map(async ([path, ref]) => {
      const sha256 = hashOf(ref);
      const head = await c.env.BLOBS.head(blobKey(sha256));
      if (!head) {
        missing.push(path);
        return;
      }
      total += head.size;
      files[path] = { sha256, size: head.size, type: contentTypeFor(path)! };
    }),
  );
  if (missing.length) {
    return {
      ok: false,
      res: apiError(c, 400, "missing_blobs", `These files were not uploaded: ${missing.sort().join(", ")}`, { missing }),
    };
  }
  if (total > MAX_VERSION_BYTES) {
    return { ok: false, res: apiError(c, 413, "too_large", `A version may hold at most 100MB; this one is ${Math.ceil(total / 1048576)}MB.`) };
  }
  return { ok: true, files };
}

// --- Pairing (unsigned: this is how a device gets its key registered) ---

const pairStartSchema = z.object({
  name: z.string().trim().min(1).max(64),
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "public_key must be a raw Ed25519 key in base64url"),
});

api.post("/devices/pair", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.PAIR_LIMITER) {
    const { success } = await c.env.PAIR_LIMITER.limit({ key: ip });
    if (!success) return apiError(c, 429, "rate_limited", "Too many login attempts. Wait a minute and try again.");
  }
  const parsed = await readJson(c, pairStartSchema);
  if (!parsed.ok) return parsed.res;
  const now = new Date();
  const pending = await c.env.DB.prepare(
    "select count(*) as n from pairings where status = 'pending' and expires_at > ? and requested_ip = ?",
  )
    .bind(now.toISOString(), ip)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PAIRINGS_PER_IP) {
    return apiError(c, 429, "rate_limited", "Too many logins from this address are waiting for approval. Approve or let them expire first.");
  }
  const code = pairingCode();
  const expires = new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString();
  await c.env.DB.prepare("insert into pairings (code, name, public_key, requested_ip, expires_at) values (?, ?, ?, ?, ?)")
    .bind(code, parsed.value.name, parsed.value.public_key, ip, expires)
    .run();
  return c.json<PairStartResponse>({ code, approve_url: `${c.get("config").origin}/pair/${code}`, expires_at: expires }, 201);
});

api.get("/devices/pair/:code", async (c) => {
  const row = await c.env.DB.prepare("select status, device_id, expires_at from pairings where code = ?")
    .bind(c.req.param("code"))
    .first<{ status: string; device_id: string | null; expires_at: string }>();
  if (!row) return c.json<PairPollResponse>({ status: "expired" });
  if (row.status === "approved" && row.device_id) return c.json<PairPollResponse>({ status: "approved", device_id: row.device_id });
  if (row.status === "denied") return c.json<PairPollResponse>({ status: "denied" });
  if (Date.parse(row.expires_at) <= Date.now()) return c.json<PairPollResponse>({ status: "expired" });
  return c.json<PairPollResponse>({ status: "pending" });
});

// --- Everything below is signed by a paired device ---

const signed = new Hono<AppEnv>();
signed.use(requireDevice());

const checkSchema = z.object({ hashes: z.array(z.string().regex(SHA256_HEX)).max(MAX_FILES_PER_VERSION) });

signed.post("/blobs/check", async (c) => {
  const parsed = await readJson(c, checkSchema);
  if (!parsed.ok) return parsed.res;
  const unique = [...new Set(parsed.value.hashes)];
  const heads = await Promise.all(unique.map((h) => c.env.BLOBS.head(blobKey(h))));
  return c.json<BlobCheckResponse>({ missing: unique.filter((_, i) => !heads[i]) });
});

signed.put("/blobs/:sha256{[0-9a-f]{64}}", async (c) => {
  const sha256 = c.req.param("sha256");
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length < 0) {
    return apiError(c, 411, "length_required", "Send Content-Length with the file.");
  }
  if (length > MAX_FILE_BYTES) {
    return apiError(c, 413, "too_large", `A file may be at most 25MB; this one is ${Math.ceil(length / 1048576)}MB.`);
  }
  if (await c.env.BLOBS.head(blobKey(sha256))) return c.body(null, 204);
  try {
    // Streamed without reading it here; R2 rejects the write if the bytes do not hash to sha256.
    await c.env.BLOBS.put(blobKey(sha256), c.req.raw.body ?? new Uint8Array(), { sha256 });
  } catch {
    return apiError(c, 400, "bad_content_hash", "The file does not match its sha256.");
  }
  return c.body(null, 201);
});

/**
 * Checks that `parentId` can hold `page` (undefined: a new page) in `project`: it exists, is in that
 * project and is not the page or under it. Returns the error response, or undefined.
 */
async function parentProblem(c: Context<AppEnv>, parentId: string, project: string | null, page?: ArtifactRow): Promise<Response | undefined> {
  const parent = await getArtifact(c.env.DB, parentId);
  if (!parent) return apiError(c, 400, "bad_parent", "The parent page does not exist (or it is in the trash).");
  if (parent.project !== project) {
    return apiError(c, 400, "bad_parent", `The parent page is in ${parent.project ? `the project ${parent.project}` : "no project"}; a page and its parent share one.`);
  }
  if (page && subtreeOf(await listProjectPages(c.env.DB, project), page.id).has(parentId)) {
    return apiError(c, 400, "bad_parent", "A page cannot go under itself or a page below it.");
  }
  return undefined;
}

signed.post("/artifacts", async (c) => {
  const parsed = await readJson(c, manifestSchema);
  if (!parsed.ok) return parsed.res;
  const manifest = parsed.value;
  let project = manifest.project;
  if (manifest.parent) {
    // The parent's project is the page's; a different project named with it is a mistake.
    const parent = await getArtifact(c.env.DB, manifest.parent);
    project = project ?? parent?.project ?? undefined;
    const problem = await parentProblem(c, manifest.parent, project ?? null);
    if (problem) return problem;
  }
  const resolved = await resolveFiles(c, manifest);
  if (!resolved.ok) return resolved.res;
  const id = randomId();
  await createArtifact(c.env.DB, id, {
    title: manifest.title,
    description: manifest.description,
    project,
    parent: manifest.parent,
    text: manifest.text,
    links: manifest.links,
    labels: manifest.labels,
    entry: manifest.entry,
    files: resolved.files,
    allowConnect: manifest.allow_connect ?? [],
    deviceId: c.get("device").id,
  });
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "artifact.create", targetType: "artifact", targetId: id,
    metadata: { version: 1, externalHosts: manifest.allow_connect?.length ?? 0 },
  });
  indexLater(semanticEnv(c.env), c.executionCtx, id);
  await record(c.env.DB, { artifactId: id, project: project ?? null, kind: "created", actor: { deviceId: device.id, name: device.name }, version: 1 });
  return c.json<PublishResponse>({ id, url: artifactUrl(c, id), version: 1 }, 201);
});

function conflict(c: Context<AppEnv>, current: number) {
  return apiError(
    c,
    409,
    "version_conflict",
    `Version ${current} is the latest. Read it, merge your changes into it, and publish again.`,
    { current_version: current },
  );
}

signed.put("/artifacts/:id", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, manifestSchema);
  if (!parsed.ok) return parsed.res;
  const manifest = parsed.value;
  const base = manifest.base_version ?? artifact.current_version;
  if (base !== artifact.current_version) return conflict(c, artifact.current_version);
  const project = manifest.project ?? artifact.project;
  if (manifest.parent) {
    const problem = await parentProblem(c, manifest.parent, project, artifact);
    if (problem) return problem;
  }
  const resolved = await resolveFiles(c, manifest);
  if (!resolved.ok) return resolved.res;
  const added = await addVersion(c.env.DB, artifact.id, base, {
    title: manifest.title,
    description: manifest.description,
    text: manifest.text,
    links: manifest.links,
    labels: manifest.labels,
    entry: manifest.entry,
    files: resolved.files,
    allowConnect: manifest.allow_connect ?? [],
    deviceId: c.get("device").id,
  });
  if (!added) {
    const latest = await getArtifact(c.env.DB, artifact.id);
    return conflict(c, latest?.current_version ?? base + 1);
  }
  if (project !== artifact.project) await setProject(c.env.DB, artifact.id, project);
  if (manifest.parent && manifest.parent !== artifact.parent) await setParent(c.env.DB, artifact.id, manifest.parent);
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "artifact.update", targetType: "artifact", targetId: artifact.id,
    metadata: { version: base + 1, externalHosts: manifest.allow_connect?.length ?? 0 },
  });
  indexLater(semanticEnv(c.env), c.executionCtx, artifact.id);
  await record(c.env.DB, { artifactId: artifact.id, project, kind: "updated", actor: { deviceId: device.id, name: device.name }, version: base + 1 });
  return c.json<PublishResponse>({ id: artifact.id, url: artifactUrl(c, artifact.id), version: base + 1 });
});

/** `?project=<name>` lists one project; `?project=` (empty) lists pages without a project; `?label=` those with a label. */
signed.get("/artifacts", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 200);
  const project = c.req.query("project");
  const label = labelSchema.safeParse(c.req.query("label") ?? "");
  const rows = await listArtifacts(c.env.DB, limit, project === undefined ? undefined : project.trim() || null, label.success ? label.data : undefined);
  const labels = await labelsOf(c.env.DB, rows.map((a) => a.id));
  return c.json<ListResponse>({ artifacts: rows.map((a) => summary(c, a, a.allow_connect, labels.get(a.id) ?? [])) });
});

/** Pages whose title, description or text has every word of `q`. An agent sees every project. */
signed.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 200);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
  const hits = await labeledSearch(semanticEnv(c.env), q, limit);
  return c.json<SearchResponse>({
    results: hits.map((h) => ({
      id: h.id,
      url: artifactUrl(c, h.id),
      title: h.title,
      project: h.project,
      updated_at: h.updated_at,
      snippet: h.snippet.replaceAll(MARK_START, "[[").replaceAll(MARK_END, "]]"),
      match: h.match,
    })),
  });
});

const textSchema = z.object({
  version: z.number().int().positive(),
  text: z.string().max(MAX_TEXT_CHARS),
  links: z.array(artifactIdSchema).max(1000),
});

/**
 * Sets the text and links of a page's current version, as the CLI read them from its files,
 * without a new version: for pages published before versions kept their text (artifact reindex).
 */
signed.put("/artifacts/:id/text", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, textSchema);
  if (!parsed.ok) return parsed.res;
  const { version, text, links } = parsed.value;
  if (version !== artifact.current_version) return conflict(c, artifact.current_version);
  await c.env.DB.batch([
    c.env.DB.prepare("update versions set text = ? where artifact_id = ? and version = ?").bind(text, artifact.id, version),
    ...indexStatements(c.env.DB, artifact.id, { title: artifact.title, description: artifact.description, text }),
    ...linkStatements(c.env.DB, artifact.id, links),
  ]);
  // The vectors follow the version, so a page whose text arrives late is embedded again.
  await c.env.DB.prepare("delete from page_vectors where artifact_id = ?").bind(artifact.id).run();
  indexLater(semanticEnv(c.env), c.executionCtx, artifact.id);
  return c.json({ id: artifact.id, version, chars: text.length, links: links.length });
});

/** A page's comments, oldest first: each thread's first comment, then its replies after it. */
signed.get("/artifacts/:id/comments", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const rows = await listComments(c.env.DB, artifact.id);
  return c.json<CommentListResponse>({
    comments: rows.map((r) => ({
      id: r.id, reply_to: r.reply_to, author: r.author_name, by_agent: r.author_device !== null, body: r.body,
      quote: r.quote, version: r.version, resolved: r.resolved_at !== null, created_at: r.created_at,
    })),
  });
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
  reply_to: z.string().optional(),
  quote: z.string().trim().max(MAX_QUOTE_CHARS).optional(),
  resolve: z.boolean().optional(),
});

/** An agent comments on a page, or replies in a thread (and may settle it, after doing what it asked). */
signed.post("/artifacts/:id/comments", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, commentSchema);
  if (!parsed.ok) return parsed.res;
  const req = parsed.value;
  if (req.reply_to) {
    const first = await getComment(c.env.DB, req.reply_to);
    if (!first || first.artifact_id !== artifact.id || first.reply_to) return apiError(c, 400, "bad_thread", "reply_to is not a thread on this page (use the id of a thread's first comment).");
  } else if (req.resolve) {
    return apiError(c, 400, "bad_request", "resolve settles the thread you reply in; send it with reply_to.");
  }
  const device = c.get("device");
  const id = await addComment(c.env.DB, {
    artifact_id: artifact.id, version: artifact.current_version, reply_to: req.reply_to ?? null,
    author_user: null, author_device: device.id, author_name: device.name, body: req.body, quote: req.reply_to ? null : (req.quote || null),
  });
  if (req.reply_to && req.resolve) await setResolved(c.env.DB, req.reply_to, true);
  const thread = req.reply_to ? await threadPeople(c.env.DB, req.reply_to) : [];
  const actor = { deviceId: device.id, name: device.name };
  await record(c.env.DB, { artifactId: artifact.id, project: artifact.project, kind: req.reply_to ? "replied" : "commented", actor, commentId: req.reply_to ?? id, thread });
  if (req.reply_to && req.resolve) await record(c.env.DB, { artifactId: artifact.id, project: artifact.project, kind: "resolved", actor, commentId: req.reply_to, thread });
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "comment.create", targetType: "artifact", targetId: artifact.id, metadata: { comment: id, reply: !!req.reply_to },
  });
  return c.json({ id, url: `${artifactUrl(c, artifact.id)}?comments=1#c-${req.reply_to ?? id}` }, 201);
});

/** What changed lately: everywhere, in one project (?project=) or on one page (?page=). */
signed.get("/activity", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30) || 30, 1), 200);
  const rows = await listActivity(c.env.DB, { project: c.req.query("project") || undefined, artifactId: c.req.query("page") || undefined, limit });
  return c.json<ActivityResponse>({
    activity: rows.map((a) => ({
      at: a.at, kind: a.kind, actor: a.actor_name, by_agent: a.actor_device !== null,
      page: { id: a.artifact_id, url: artifactUrl(c, a.artifact_id), title: a.title, project: a.project },
      version: a.version, comment_id: a.comment_id,
    })),
  });
});

signed.get("/projects", async (c) => {
  return c.json<ProjectListResponse>({ projects: await listProjects(c.env.DB) });
});

const moveSchema = z
  .object({
    project: projectSchema.nullable().optional(),
    parent: artifactIdSchema.nullable().optional(),
    position: z.number().int().positive().optional(),
  })
  .refine((m) => m.project !== undefined || m.parent !== undefined || m.position !== undefined, "send project, parent or position");

/**
 * Moves a page without a new version: to another project (with the pages under it, to its top;
 * null leaves it without one), under another page (null: the top), or to a place among its siblings.
 */
signed.patch("/artifacts/:id", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, moveSchema);
  if (!parsed.ok) return parsed.res;
  const move = parsed.value;
  const project = move.project === undefined ? artifact.project : move.project;
  if (move.parent) {
    const problem = await parentProblem(c, move.parent, project, artifact);
    if (problem) return problem;
  }
  if (project !== artifact.project) await setProject(c.env.DB, artifact.id, project);
  if (move.parent !== undefined && move.parent !== (project !== artifact.project ? null : artifact.parent)) {
    await setParent(c.env.DB, artifact.id, move.parent);
  }
  if (move.position !== undefined) await placeAmongSiblings(c.env.DB, await listProjectPages(c.env.DB, project), artifact.id, move.position);
  const moved = (await getArtifact(c.env.DB, artifact.id))!;
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "artifact.move", targetType: "artifact", targetId: artifact.id,
    metadata: { project: moved.project, parent: moved.parent, position: moved.position },
  });
  return c.json<MoveResponse>({ id: moved.id, project: moved.project, parent: moved.parent, position: moved.position });
});

const labelChangeSchema = z
  .object({ set: labelsSchema.optional(), add: labelsSchema.optional(), remove: z.array(labelSchema).max(100).optional() })
  .refine((r) => r.set || r.add || r.remove, "Give set, add or remove.");

/** Changes a page's labels, without a new version. */
signed.post("/artifacts/:id/labels", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, labelChangeSchema);
  if (!parsed.ok) return parsed.res;
  const labels = await changeLabels(c.env.DB, artifact.id, parsed.value);
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "artifact.labels", targetType: "artifact", targetId: artifact.id,
    metadata: { labels: labels.length },
  });
  return c.json<LabelResponse>({ id: artifact.id, labels });
});

signed.get("/artifacts/:id", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const [versions, from, to, labels] = await Promise.all([
    listVersions(c.env.DB, artifact.id),
    linkedFrom(c.env.DB, artifact.id),
    linksTo(c.env.DB, artifact.id),
    labelsOf(c.env.DB, [artifact.id]),
  ]);
  const current = versions.find((v) => v.version === artifact.current_version);
  const link = (p: { id: string; title: string }) => ({ id: p.id, url: artifactUrl(c, p.id), title: p.title });
  return c.json<ArtifactDetail>({
    ...summary(c, artifact, current?.allow_connect ?? [], labels.get(artifact.id) ?? []),
    linked_from: from.map(link),
    links_to: to.map(link),
    versions: versions.map((v) => ({
      version: v.version,
      entry: v.entry,
      files: v.files,
      created_by: v.created_by,
      created_at: v.created_at,
    })),
  });
});

signed.get("/artifacts/:id/files/*", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const requested = Number(c.req.query("version") ?? artifact.current_version);
  const version = await getVersion(c.env.DB, artifact.id, requested);
  if (!version) return apiError(c, 404, "not_found", `Version ${requested} does not exist.`);
  const prefix = `/api/v1/artifacts/${artifact.id}/files/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)) || version.entry;
  const file = version.files[path];
  if (!file) return apiError(c, 404, "not_found", `Version ${requested} has no file ${path}.`);
  const object = await c.env.BLOBS.get(blobKey(file.sha256));
  if (!object) return apiError(c, 500, "blob_missing", `The stored bytes of ${path} are missing.`);
  return new Response(object.body, { headers: { "content-type": file.type, "x-artifact-version": String(version.version) } });
});

signed.delete("/artifacts/:id", async (c) => {
  const id = c.req.param("id");
  // The pages under it move up; a restriction it had stays on them.
  await passOnRestriction(c.env.DB, id);
  const trashed = await trashArtifact(c.env.DB, id);
  if (!trashed) return apiError(c, 404, "not_found", "No artifact has this id (or it is already in the trash).");
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "artifact.trash", targetType: "artifact", targetId: id,
  });
  return c.json({ trashed: true, restore: `${c.get("config").origin}/settings#trash` });
});

const loginLinkSchema = z.object({ next: z.string().max(2000).optional() });

/**
 * A single-use sign-in link for the browser, for `artifact open`. It signs in as the user who
 * approved this device, but only with permission to browse artifacts. An unowned device may
 * create the first owner during initial bootstrap; it is never transferred to an existing owner.
 */
signed.post("/login-links", async (c) => {
  const parsed = await readJson(c, loginLinkSchema);
  if (!parsed.ok) return parsed.res;
  const device = c.get("device");
  let user = device.userId ? await getUser(c.env.DB, device.userId) : null;
  if (!user && device.userId) {
    // This should normally be handled by deleteUser. Fail closed if an inconsistent row remains.
    await c.env.DB.prepare("update devices set revoked_at = coalesce(revoked_at, ?) where id = ?")
      .bind(new Date().toISOString(), device.id)
      .run();
    return apiError(c, 403, "device_owner_missing", "The person who approved this device no longer exists. Pair it again.");
  }
  if (!user) {
    const root = await firstRoot(c.env.DB);
    if (root) {
      // Null ownership is reserved for first-owner bootstrap. Never transfer an orphaned key to
      // another owner, because it may belong to a user who was removed.
      await c.env.DB.prepare("update devices set revoked_at = coalesce(revoked_at, ?) where id = ?")
        .bind(new Date().toISOString(), device.id)
        .run();
      return apiError(c, 403, "device_owner_missing", "This device is not associated with an account. Pair it again.");
    }
    user = await createUser(c.env.DB, { name: "Owner", role: "root" });
    await c.env.DB.prepare("update devices set user_id = ? where id = ? and user_id is null").bind(user.id, device.id).run();
  }
  const next = safeNext(parsed.value.next, c.get("config").origin);
  const token = await createLoginLink(c.env.DB, user.id, next, "device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "auth.device_link_create", targetType: "user", targetId: user.id,
  });
  return c.json({ url: `${c.get("config").origin}/auth/link/${token}`, expires_in: LOGIN_LINK_SECONDS }, 201);
});

// --- Secret handoff: the recipient's browser holds the key; the API only relays ciphertext ---

signed.post("/secrets", async (c) => {
  const parsed = await readJson(c, secretCreateSchema);
  if (!parsed.ok) return parsed.res;
  const { label, expires_in_hours, share } = parsed.value;
  const mode = share ? "share" : "request";
  const id = randomId();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + (expires_in_hours ?? SECRET_DEFAULT_HOURS) * 3600e3).toISOString();
  const device = c.get("device");
  await createSecret(c.env.DB, {
    id, mode, tokenHash: await sha256Hex(token), label, deviceId: device.id, expiresAt,
    // Share mode: the inner envelope; its key is in the part of the link the server never sees.
    ...(share ? { ciphertext: JSON.stringify(share) } : {}),
  });
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "secret.create", targetType: "secret", targetId: id,
    metadata: { hours: expires_in_hours ?? SECRET_DEFAULT_HOURS, mode },
  });
  return c.json<SecretCreateResponse>({ id, mode, url: `${c.get("config").origin}/secret/${token}`, label, expires_at: expiresAt }, 201);
});

signed.get("/secrets", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 200);
  const rows = await listSecrets(c.env.DB, limit);
  return c.json<SecretListResponse>({ secrets: rows.map((r) => secretSummary(r)) });
});

const SECRET_NOT_FOUND = "No secret request has this id.";

signed.get("/secrets/:id", async (c) => {
  const row = await getSecret(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, 404, "not_found", SECRET_NOT_FOUND);
  return c.json<SecretSummary>(secretSummary(row));
});

signed.put("/secrets/:id/sealed", async (c) => {
  const row = await getSecret(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, 404, "not_found", SECRET_NOT_FOUND);
  if (row.mode === "share") {
    return apiError(c, 409, "share_mode", "This is a share link: its ciphertext was put when it was made, and the first browser that opens it reads it.");
  }
  const status = secretStatus(row);
  if (status === "waiting") {
    return apiError(c, 409, "not_claimed", "Nobody has opened the link yet. Send it to the recipient, then wait until the status is claimed.");
  }
  if (status === "sealed") return apiError(c, 409, "already_sealed", "This request already holds a secret. Delete it and make a new request to send another.");
  if (status !== "claimed") return apiError(c, 410, "gone", `This request has ended (${status}). Make a new request.`);
  const parsed = await readJson(c, secretSealSchema);
  if (!parsed.ok) return parsed.res;
  if (!(await sealSecret(c.env.DB, row.id, JSON.stringify(parsed.value.envelope)))) {
    return apiError(c, 409, "not_sealed", "The request changed while sending. Check its status and try again.");
  }
  const device = c.get("device");
  await recordAuditEvent(c, {
    actorType: "device", actorId: device.id, actorLabel: device.name,
    action: "secret.seal", targetType: "secret", targetId: row.id,
  });
  return c.json({ status: "sealed" });
});

signed.delete("/secrets/:id", async (c) => {
  const row = await getSecret(c.env.DB, c.req.param("id"));
  if (!row) return apiError(c, 404, "not_found", SECRET_NOT_FOUND);
  const finished = await finishSecret(c.env.DB, row.id, "device");
  if (finished) {
    const device = c.get("device");
    await recordAuditEvent(c, {
      actorType: "device", actorId: device.id, actorLabel: device.name,
      action: "secret.delete", targetType: "secret", targetId: row.id,
    });
  }
  return c.json({ deleted: true, status: finished ? "deleted" : secretStatus(row) });
});

api.route("/", signed);
