import type { VersionFile } from "@article/shared";

export interface ArtifactRow {
  id: string;
  title: string;
  description: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface VersionRow {
  artifact_id: string;
  version: number;
  entry: string;
  files: Record<string, VersionFile>;
  allow_connect: string[];
  created_by: string;
  created_at: string;
}

interface RawVersionRow extends Omit<VersionRow, "files" | "allow_connect"> {
  files: string;
  allow_connect: string | null;
}

function parseVersion(row: RawVersionRow): VersionRow {
  return {
    ...row,
    files: JSON.parse(row.files) as Record<string, VersionFile>,
    allow_connect: row.allow_connect ? (JSON.parse(row.allow_connect) as string[]) : [],
  };
}

export interface ArtifactWithVersion extends ArtifactRow {
  allow_connect: string[];
}

export async function listArtifacts(db: D1Database, limit: number): Promise<ArtifactWithVersion[]> {
  const { results } = await db
    .prepare(
      `select a.*, v.allow_connect from artifacts a
       join versions v on v.artifact_id = a.id and v.version = a.current_version
       where a.deleted_at is null order by a.updated_at desc limit ?`,
    )
    .bind(limit)
    .all<ArtifactRow & { allow_connect: string | null }>();
  return results.map((r) => ({ ...r, allow_connect: r.allow_connect ? (JSON.parse(r.allow_connect) as string[]) : [] }));
}

export async function listTrash(db: D1Database): Promise<ArtifactRow[]> {
  const { results } = await db
    .prepare("select * from artifacts where deleted_at is not null order by deleted_at desc")
    .all<ArtifactRow>();
  return results;
}

/** Artifacts whose current version may connect to other hosts. */
export async function listConnecting(db: D1Database): Promise<ArtifactWithVersion[]> {
  return (await listArtifacts(db, 1000)).filter((a) => a.allow_connect.length > 0);
}

export async function getArtifact(db: D1Database, id: string, opts: { includeDeleted?: boolean } = {}): Promise<ArtifactRow | undefined> {
  const row = await db.prepare("select * from artifacts where id = ?").bind(id).first<ArtifactRow>();
  if (!row || (row.deleted_at && !opts.includeDeleted)) return undefined;
  return row;
}

export async function getVersion(db: D1Database, id: string, version: number): Promise<VersionRow | undefined> {
  const row = await db
    .prepare("select * from versions where artifact_id = ? and version = ?")
    .bind(id, version)
    .first<RawVersionRow>();
  return row ? parseVersion(row) : undefined;
}

export async function listVersions(db: D1Database, id: string): Promise<VersionRow[]> {
  const { results } = await db
    .prepare("select * from versions where artifact_id = ? order by version desc")
    .bind(id)
    .all<RawVersionRow>();
  return results.map(parseVersion);
}

export interface NewVersion {
  title: string;
  description: string | undefined;
  entry: string;
  files: Record<string, VersionFile>;
  allowConnect: string[];
  deviceId: string;
}

function versionInsert(db: D1Database, id: string, version: number, v: NewVersion, now: string): D1PreparedStatement {
  return db
    .prepare(
      "insert into versions (artifact_id, version, entry, files, allow_connect, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, version, v.entry, JSON.stringify(v.files), v.allowConnect.length ? JSON.stringify(v.allowConnect) : null, v.deviceId, now);
}

export async function createArtifact(db: D1Database, id: string, v: NewVersion): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "insert into artifacts (id, title, description, current_version, created_at, updated_at) values (?, ?, ?, 1, ?, ?)",
      )
      .bind(id, v.title, v.description ?? null, now, now),
    versionInsert(db, id, 1, v, now),
  ]);
}

/**
 * Adds version `expected + 1` and makes it current. Returns false when another publish got
 * there first: that version already exists, so the insert violates the primary key and the
 * batch (one transaction) rolls back.
 */
export async function addVersion(db: D1Database, id: string, expected: number, v: NewVersion): Promise<boolean> {
  const now = new Date().toISOString();
  const next = expected + 1;
  try {
    await db.batch([
      versionInsert(db, id, next, v, now),
      db
        .prepare("update artifacts set current_version = ?, title = ?, description = ?, updated_at = ? where id = ?")
        .bind(next, v.title, v.description ?? null, now, id),
    ]);
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) return false;
    throw e;
  }
}

export async function trashArtifact(db: D1Database, id: string): Promise<boolean> {
  const r = await db
    .prepare("update artifacts set deleted_at = ? where id = ? and deleted_at is null")
    .bind(new Date().toISOString(), id)
    .run();
  return r.meta.changes === 1;
}

export async function restoreArtifact(db: D1Database, id: string): Promise<void> {
  await db.prepare("update artifacts set deleted_at = null where id = ?").bind(id).run();
}

/** Removes outbound access from every version, until the next publish asks for it again. */
export async function revokeConnect(db: D1Database, id: string): Promise<void> {
  await db.prepare("update versions set allow_connect = null where artifact_id = ?").bind(id).run();
}
