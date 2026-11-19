/**
 * Page restrictions. A page is open (as its project allows), restricted for editing (only the
 * people listed with "edit" change it), or restricted for viewing (only the people listed see
 * it; those listed with "edit" also change it). A restriction holds for the pages under it too:
 * a page is visible only when every restriction on it and above it lets the person in. The
 * owner (root) is never restricted, and the project's rules (members-only projects, editors)
 * apply first. Agents act for the owner, so the API sees every page.
 */
import type { Viewer } from "../app-env.ts";
import { canEditProject, canSeeProject, hiddenProjects } from "./spaces.ts";

export type Restriction = "edit" | "view";
export type Can = "view" | "edit";
type Who = Pick<Viewer, "userId" | "role">;

/** Pages hidden from a person by a view restriction on them or above them. */
const HIDDEN = `with recursive hidden(id) as (
  select a.id from artifacts a where a.deleted_at is null and a.restriction = 'view'
    and not exists (select 1 from page_access p where p.artifact_id = a.id and p.user_id = ?)
  union
  select c.id from artifacts c join hidden h on c.parent = h.id where c.deleted_at is null
) select h.id, a.project from hidden h join artifacts a on a.id = h.id`;

/** Pages a person may not change because of a restriction on them or above them. */
const LOCKED = `with recursive locked(id) as (
  select a.id from artifacts a where a.deleted_at is null and a.restriction is not null
    and not exists (select 1 from page_access p where p.artifact_id = a.id and p.user_id = ? and p.can = 'edit')
  union
  select c.id from artifacts c join locked l on c.parent = l.id where c.deleted_at is null
) select id from locked`;

/** What one person may see and change, for filtering lists of pages. */
export interface Access {
  hiddenProjects: Set<string>;
  hiddenPages: Set<string>;
  /** Of the hidden pages, how many each project has (null: those without one). */
  hiddenPerProject: Map<string | null, number>;
  lockedPages: Set<string>;
  sees(page: { id: string; project: string | null }): boolean;
}

const OPEN: Access = {
  hiddenProjects: new Set(),
  hiddenPages: new Set(),
  hiddenPerProject: new Map(),
  lockedPages: new Set(),
  sees: () => true,
};

export async function accessFor(db: D1Database, who: Who): Promise<Access> {
  if (who.role === "root") return OPEN;
  const projects = await hiddenProjects(db, who);
  const hiddenPages = new Set<string>();
  const hiddenPerProject = new Map<string | null, number>();
  const lockedPages = new Set<string>();
  if (await db.prepare("select 1 as x from artifacts where restriction is not null and deleted_at is null limit 1").first()) {
    const [h, l] = await db.batch<{ id: string; project?: string | null }>([db.prepare(HIDDEN).bind(who.userId), db.prepare(LOCKED).bind(who.userId)]);
    for (const r of h!.results) {
      hiddenPages.add(r.id);
      hiddenPerProject.set(r.project ?? null, (hiddenPerProject.get(r.project ?? null) ?? 0) + 1);
    }
    for (const r of l!.results) lockedPages.add(r.id);
  }
  return {
    hiddenProjects: projects,
    hiddenPages,
    hiddenPerProject,
    lockedPages,
    sees: (p) => (!p.project || !projects.has(p.project)) && !hiddenPages.has(p.id),
  };
}

export interface PathRestriction {
  id: string;
  title: string;
  restriction: Restriction;
  /** On the page itself, not on a page above it. */
  own: boolean;
}

/** The restrictions on a page and on the pages above it, nearest first. */
export async function restrictionsOn(db: D1Database, id: string): Promise<PathRestriction[]> {
  const { results } = await db
    .prepare(
      `with recursive path(id, parent, title, restriction, depth) as (
         select id, parent, title, restriction, 0 from artifacts where id = ?
         union all
         select a.id, a.parent, a.title, a.restriction, p.depth + 1 from artifacts a join path p on a.id = p.parent where p.depth < 100
       ) select id, title, restriction, depth from path where restriction is not null order by depth`,
    )
    .bind(id)
    .all<{ id: string; title: string; restriction: Restriction; depth: number }>();
  return results.map((r) => ({ id: r.id, title: r.title, restriction: r.restriction, own: r.depth === 0 }));
}

/** What the restrictions on a page and above it let a person do (the project's rules aside). */
export async function pageAllows(db: D1Database, who: Who, id: string): Promise<{ view: boolean; edit: boolean }> {
  if (who.role === "root") return { view: true, edit: true };
  const path = await restrictionsOn(db, id);
  if (path.length === 0) return { view: true, edit: true };
  const ids = path.map((p) => p.id);
  const { results } = await db
    .prepare(`select artifact_id, can from page_access where user_id = ? and artifact_id in (${ids.map(() => "?").join(", ")})`)
    .bind(who.userId, ...ids)
    .all<{ artifact_id: string; can: Can }>();
  const can = new Map(results.map((r) => [r.artifact_id, r.can]));
  const view = path.every((p) => p.restriction !== "view" || can.has(p.id));
  return { view, edit: view && path.every((p) => can.get(p.id) === "edit") };
}

export async function canSeePage(db: D1Database, who: Who, page: { id: string; project: string | null }): Promise<boolean> {
  return (await canSeeProject(db, who, page.project)) && (await pageAllows(db, who, page.id)).view;
}

export async function canEditPage(db: D1Database, who: Who, page: { id: string; project: string | null }): Promise<boolean> {
  return (await canEditProject(db, who, page.project)) && (await pageAllows(db, who, page.id)).edit;
}

/**
 * Of the people who may see a page's project, a test for those the page's restrictions let see
 * it too (the owner always). For telling people about a page, and for naming them in it.
 */
export async function pageAudience(db: D1Database, id: string): Promise<(user: { id: string; role: string }) => boolean> {
  const path = (await restrictionsOn(db, id)).filter((p) => p.restriction === "view");
  if (path.length === 0) return () => true;
  const ids = path.map((p) => p.id);
  const { results } = await db
    .prepare(`select artifact_id, user_id from page_access where artifact_id in (${ids.map(() => "?").join(", ")})`)
    .bind(...ids)
    .all<{ artifact_id: string; user_id: string }>();
  const listed = new Map<string, Set<string>>();
  for (const r of results) {
    if (!listed.has(r.artifact_id)) listed.set(r.artifact_id, new Set());
    listed.get(r.artifact_id)!.add(r.user_id);
  }
  return (user) => user.role === "root" || ids.every((pid) => listed.get(pid)?.has(user.id) ?? false);
}

export interface AccessRow {
  user_id: string;
  name: string;
  can: Can;
}

export async function listAccess(db: D1Database, id: string): Promise<AccessRow[]> {
  const { results } = await db
    .prepare("select p.user_id, u.name, p.can from page_access p join users u on u.id = p.user_id where p.artifact_id = ? order by u.name")
    .bind(id)
    .all<AccessRow>();
  return results;
}

/** Sets how a page is restricted; whoever restricts it (unless the owner) stays able to change it. */
export async function setRestriction(db: D1Database, id: string, restriction: Restriction | null, by: Who): Promise<void> {
  await db.batch([
    db.prepare("update artifacts set restriction = ? where id = ?").bind(restriction, id),
    ...(restriction && by.role !== "root"
      ? [db.prepare("insert into page_access (artifact_id, user_id, can) values (?, ?, 'edit') on conflict (artifact_id, user_id) do update set can = 'edit'").bind(id, by.userId)]
      : []),
  ]);
}

export async function setAccess(db: D1Database, id: string, userId: string, can: Can | null): Promise<void> {
  await (can
    ? db.prepare("insert into page_access (artifact_id, user_id, can) values (?, ?, ?) on conflict (artifact_id, user_id) do update set can = excluded.can").bind(id, userId, can)
    : db.prepare("delete from page_access where artifact_id = ? and user_id = ?").bind(id, userId)
  ).run();
}

const RANK = { none: 0, view: 1, edit: 2 } as const;
type Level = keyof typeof RANK;

/**
 * Before a restricted page goes to the trash, the pages under it (which move up to its parent)
 * take over its restriction, so nobody gains access to them: each gets the stronger restriction
 * of the two, and each person the lesser of what the two allowed them.
 */
export async function passOnRestriction(db: D1Database, id: string): Promise<void> {
  const page = await db.prepare("select restriction from artifacts where id = ?").bind(id).first<{ restriction: Restriction | null }>();
  if (!page?.restriction) return;
  const { results: children } = await db
    .prepare("select id, restriction from artifacts where parent = ? and deleted_at is null")
    .bind(id)
    .all<{ id: string; restriction: Restriction | null }>();
  if (children.length === 0) return;
  const ids = [id, ...children.map((c) => c.id)];
  const { results: rows } = await db
    .prepare(`select artifact_id, user_id, can from page_access where artifact_id in (${ids.map(() => "?").join(", ")})`)
    .bind(...ids)
    .all<{ artifact_id: string; user_id: string; can: Can }>();
  const listed = new Map<string, Map<string, Can>>();
  for (const r of rows) {
    if (!listed.has(r.artifact_id)) listed.set(r.artifact_id, new Map());
    listed.get(r.artifact_id)!.set(r.user_id, r.can);
  }
  const level = (pageId: string, restriction: Restriction | null, user: string): Level => {
    if (!restriction) return "edit";
    const can = listed.get(pageId)?.get(user);
    if (restriction === "view") return can ?? "none";
    return can === "edit" ? "edit" : "view";
  };
  const statements: D1PreparedStatement[] = [];
  for (const child of children) {
    const restriction: Restriction = page.restriction === "view" || child.restriction === "view" ? "view" : "edit";
    const people = new Set([...(listed.get(id)?.keys() ?? []), ...(listed.get(child.id)?.keys() ?? [])]);
    statements.push(db.prepare("update artifacts set restriction = ? where id = ?").bind(restriction, child.id));
    statements.push(db.prepare("delete from page_access where artifact_id = ?").bind(child.id));
    for (const user of people) {
      const a = level(id, page.restriction, user), b = level(child.id, child.restriction, user);
      const least: Level = RANK[a] <= RANK[b] ? a : b;
      if (least === "edit" || (least === "view" && restriction === "view")) {
        statements.push(db.prepare("insert into page_access (artifact_id, user_id, can) values (?, ?, ?)").bind(child.id, user, least));
      }
    }
  }
  await db.batch(statements);
}

export function purgeAccessStatements(db: D1Database, cutoff: string): D1PreparedStatement[] {
  return [db.prepare("delete from page_access where artifact_id in (select id from artifacts where deleted_at is not null and deleted_at <= ?)").bind(cutoff)];
}
