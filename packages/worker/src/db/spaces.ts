import type { Viewer } from "../app-env.ts";

/**
 * Spaces: a project with a description, a tree of pages and who may see it. `everyone` is every
 * viewer, as projects were before; `members` is the owner and the viewers listed for the space.
 * A page without a project is open to every viewer.
 */
export type SpaceAccess = "everyone" | "members";
export type SpaceRole = "viewer" | "editor";

export interface SpaceRow {
  name: string;
  description: string | null;
  access: SpaceAccess;
  created_at: string;
}

export interface MemberRow {
  user_id: string;
  name: string;
  role: SpaceRole;
}

/** Creates the space row for a project the first time a page goes into it. */
export function ensureSpace(db: D1Database, name: string, now = new Date().toISOString()): D1PreparedStatement {
  return db.prepare("insert or ignore into spaces (name, created_at) values (?, ?)").bind(name, now);
}

export async function getSpace(db: D1Database, name: string): Promise<SpaceRow | null> {
  return db.prepare("select * from spaces where name = ?").bind(name).first<SpaceRow>();
}

export async function updateSpace(db: D1Database, name: string, fields: { description: string | null; access: SpaceAccess }): Promise<void> {
  await db.batch([
    ensureSpace(db, name),
    db.prepare("update spaces set description = ?, access = ? where name = ?").bind(fields.description, fields.access, name),
  ]);
}

export async function listMembers(db: D1Database, space: string): Promise<MemberRow[]> {
  const { results } = await db
    .prepare("select m.user_id, u.name, m.role from space_members m join users u on u.id = m.user_id where m.space = ? order by u.name")
    .bind(space)
    .all<MemberRow>();
  return results;
}

export async function setMember(db: D1Database, space: string, userId: string, role: SpaceRole): Promise<void> {
  await db.batch([
    ensureSpace(db, space),
    db.prepare("insert into space_members (space, user_id, role) values (?, ?, ?) on conflict (space, user_id) do update set role = excluded.role")
      .bind(space, userId, role),
  ]);
}

export async function removeMember(db: D1Database, space: string, userId: string): Promise<void> {
  await db.prepare("delete from space_members where space = ? and user_id = ?").bind(space, userId).run();
}

/** The projects `viewer` may not open: members-only spaces they are not a member of. */
export async function hiddenProjects(db: D1Database, viewer: Pick<Viewer, "role" | "userId">): Promise<Set<string>> {
  if (viewer.role === "root") return new Set();
  const { results } = await db
    .prepare(
      `select s.name from spaces s where s.access = 'members'
       and not exists (select 1 from space_members m where m.space = s.name and m.user_id = ?)`,
    )
    .bind(viewer.userId)
    .all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

export async function canSeeProject(db: D1Database, viewer: Pick<Viewer, "role" | "userId">, project: string | null): Promise<boolean> {
  if (viewer.role === "root" || project === null) return true;
  return !(await hiddenProjects(db, viewer)).has(project);
}

/** Whether `viewer` may rearrange (and, from the browser, change) the pages of `project`: the owner, or its editors. */
export async function canEditProject(db: D1Database, viewer: Pick<Viewer, "role" | "userId">, project: string | null): Promise<boolean> {
  if (viewer.role === "root") return true;
  if (project === null) return false;
  const row = await db.prepare("select role from space_members where space = ? and user_id = ?").bind(project, viewer.userId).first<{ role: string }>();
  return row?.role === "editor";
}

/** Everyone who may see a page of `project`, for naming them in a comment. */
export async function peopleWhoCanSee(db: D1Database, project: string | null): Promise<{ id: string; name: string; role: string }[]> {
  const { results } = await db
    .prepare(
      `select u.id, u.name, u.role from users u where u.role = 'root' or ? is null
         or not exists (select 1 from spaces s where s.name = ? and s.access = 'members')
         or exists (select 1 from space_members m where m.space = ? and m.user_id = u.id)
       order by u.name`,
    )
    .bind(project, project, project)
    .all<{ id: string; name: string; role: string }>();
  return results;
}
