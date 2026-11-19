import type { ProjectCount, VersionFile } from "@artifact/shared";
import { ensureSpace } from "./spaces.ts";

export interface ArtifactRow {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  parent: string | null; // the page above it in the same project; see the tree functions below
  position: number;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  share_nonce: string | null; // public link; see share.ts
  share_expires_at: string | null;
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

/**
 * Newest first. `project` narrows the list: a name for that project, null for pages without
 * one, undefined for all pages.
 */
export async function listArtifacts(db: D1Database, limit: number, project?: string | null): Promise<ArtifactWithVersion[]> {
  const where = project === undefined ? "" : project === null ? "and a.project is null" : "and a.project = ?";
  const { results } = await db
    .prepare(
      `select a.*, v.allow_connect from artifacts a
       join versions v on v.artifact_id = a.id and v.version = a.current_version
       where a.deleted_at is null ${where} order by a.updated_at desc limit ?`,
    )
    .bind(...(typeof project === "string" ? [project, limit] : [limit]))
    .all<ArtifactRow & { allow_connect: string | null }>();
  return results.map((r) => ({ ...r, allow_connect: r.allow_connect ? (JSON.parse(r.allow_connect) as string[]) : [] }));
}

/** Projects with how many pages each, the most recently updated first; pages without a project count as null. */
export async function listProjects(db: D1Database): Promise<ProjectCount[]> {
  const { results } = await db
    .prepare(
      `select project, count(*) as count from artifacts where deleted_at is null
       group by project order by max(updated_at) desc`,
    )
    .all<ProjectCount>();
  return results;
}

/**
 * Moves a page, with the pages under it, to another project (null: none), at that project's top.
 * False when there is no such page.
 */
export async function setProject(db: D1Database, id: string, project: string | null): Promise<boolean> {
  const page = await getArtifact(db, id);
  if (!page) return false;
  if (page.project === project) return true;
  const moving = [...subtreeOf(await listProjectPages(db, page.project), id)];
  const marks = moving.map(() => "?").join(", ");
  await db.batch([
    ...(project ? [ensureSpace(db, project)] : []),
    db.prepare(`update artifacts set project = ? where id in (${marks})`).bind(project, ...moving),
  ]);
  await setParent(db, id, null);
  return true;
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
  /** On create, the project. On update, undefined keeps the page's project. */
  project?: string | undefined;
  /** On create, the page it goes under (already checked to be in `project`). */
  parent?: string | undefined;
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
  const parent = v.parent ?? null;
  await db.batch([
    ...(v.project ? [ensureSpace(db, v.project, now)] : []),
    db
      .prepare(
        `insert into artifacts (id, title, description, project, parent, position, current_version, created_at, updated_at)
         values (?, ?, ?, ?, ?, (select coalesce(max(position), 0) + 1 from artifacts where parent is ? and project is ? and deleted_at is null), 1, ?, ?)`,
      )
      .bind(id, v.title, v.description ?? null, v.project ?? null, parent, parent, v.project ?? null, now, now),
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
      ...(v.project ? [ensureSpace(db, v.project, now)] : []),
      versionInsert(db, id, next, v, now),
      db
        .prepare("update artifacts set current_version = ?, title = ?, description = ?, project = coalesce(?, project), updated_at = ? where id = ?")
        .bind(next, v.title, v.description ?? null, v.project ?? null, now, id),
    ]);
    return true;
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) return false;
    throw e;
  }
}

/**
 * Moving to the trash also turns the public link off, so restoring does not reopen it. The pages
 * under it move up to its parent, so the tree never points into the trash.
 */
export async function trashArtifact(db: D1Database, id: string): Promise<boolean> {
  const [, r] = await db.batch([
    db.prepare("update artifacts set parent = (select parent from artifacts where id = ?) where parent = ? and deleted_at is null").bind(id, id),
    db
      .prepare("update artifacts set deleted_at = ?, share_nonce = null, share_expires_at = null where id = ? and deleted_at is null")
      .bind(new Date().toISOString(), id),
  ]);
  return r!.meta.changes === 1;
}

/** A restored page comes back at the top of its project when its parent is gone. */
export async function restoreArtifact(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("update artifacts set deleted_at = null where id = ?").bind(id),
    db
      .prepare(
        `update artifacts set parent = null where id = ? and parent is not null and not exists
         (select 1 from artifacts p where p.id = artifacts.parent and p.deleted_at is null and p.project is artifacts.project)`,
      )
      .bind(id),
  ]);
}

// --- The tree of pages in a project ---

export interface TreeRow {
  id: string;
  title: string;
  parent: string | null;
  position: number;
  current_version: number;
  updated_at: string;
}

/** Every page in a project (null: the pages without one), for building its tree. */
export async function listProjectPages(db: D1Database, project: string | null): Promise<TreeRow[]> {
  const { results } = await db
    .prepare(
      `select id, title, parent, position, current_version, updated_at from artifacts
       where deleted_at is null and project is ? order by position, title`,
    )
    .bind(project)
    .all<TreeRow>();
  return results;
}

/** Children of each page, ordered; pages whose parent is not in `rows` are at the top (key null). */
export function childrenOf(rows: TreeRow[]): Map<string | null, TreeRow[]> {
  const ids = new Set(rows.map((r) => r.id));
  const out = new Map<string | null, TreeRow[]>();
  for (const r of rows) {
    const key = r.parent && ids.has(r.parent) ? r.parent : null;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(r);
  }
  return out;
}

/** The pages from the top down to (not including) `id`. */
export function ancestorsOf(rows: TreeRow[], id: string): TreeRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: TreeRow[] = [];
  let at = byId.get(id)?.parent;
  while (at && byId.has(at) && !out.some((r) => r.id === at)) {
    out.unshift(byId.get(at)!);
    at = byId.get(at)!.parent;
  }
  return out;
}

/** `id` and every page under it. */
export function subtreeOf(rows: TreeRow[], id: string): Set<string> {
  const kids = childrenOf(rows), out = new Set<string>([id]), todo = [id];
  while (todo.length) for (const k of kids.get(todo.pop()!) ?? []) if (!out.has(k.id)) { out.add(k.id); todo.push(k.id); }
  return out;
}

/** The pages with the same parent as `id`, in order, its own entry included. */
export function siblingsOf(rows: TreeRow[], id: string): TreeRow[] {
  const self = rows.find((r) => r.id === id);
  if (!self) return [];
  return childrenOf(rows).get(rows.some((r) => r.id === self.parent) ? self.parent : null) ?? [];
}

/**
 * Puts `id` under `parent` (null: at the top) as the last child. The caller has checked that
 * `parent` is in the same project and not under `id`.
 */
export async function setParent(db: D1Database, id: string, parent: string | null): Promise<void> {
  await db
    .prepare(
      `update artifacts set parent = ?, position = (select coalesce(max(position), 0) + 1 from artifacts
       where parent is ? and project is (select project from artifacts where id = ?) and deleted_at is null and id != ?) where id = ?`,
    )
    .bind(parent, parent, id, id, id)
    .run();
}

/** Puts `id` at `place` (from 1) among its siblings, and numbers them all again. */
export async function placeAmongSiblings(db: D1Database, rows: TreeRow[], id: string, place: number): Promise<boolean> {
  const order = siblingsOf(rows, id).map((r) => r.id);
  const at = order.indexOf(id);
  if (at < 0) return false;
  order.splice(at, 1);
  order.splice(Math.min(Math.max(place, 1), order.length + 1) - 1, 0, id);
  await db.batch(order.map((sid, k) => db.prepare("update artifacts set position = ? where id = ?").bind(k + 1, sid)));
  return true;
}

/** Removes outbound access from every version, until the next publish asks for it again. */
export async function revokeConnect(db: D1Database, id: string): Promise<void> {
  await db.prepare("update versions set allow_connect = null where artifact_id = ?").bind(id).run();
}

/** Opens (or extends) the public link with `nonce` until `expiresAt`. */
export async function setShare(db: D1Database, id: string, nonce: string, expiresAt: string): Promise<void> {
  await db.prepare("update artifacts set share_nonce = ?, share_expires_at = ? where id = ? and deleted_at is null").bind(nonce, expiresAt, id).run();
}

export async function clearShare(db: D1Database, id: string): Promise<void> {
  await db.prepare("update artifacts set share_nonce = null, share_expires_at = null where id = ?").bind(id).run();
}
