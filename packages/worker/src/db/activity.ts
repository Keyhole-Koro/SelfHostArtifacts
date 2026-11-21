/**
 * Activity on pages, watches and notifications. Every change to a page or its comments is one
 * row of activity; it becomes a notification for the people it concerns: those mentioned in a
 * comment, those who wrote in the thread it answers, and those watching the page or its project.
 * Nobody is told about their own doing, and nobody about a page they may not see.
 */
import { randomId } from "../lib/encoding.ts";
import { pageAudience } from "./access.ts";

export type ActivityKind = "created" | "updated" | "commented" | "replied" | "resolved";
export type Reason = "mentioned" | "thread" | "watching";

export interface Actor {
  userId?: string;
  deviceId?: string;
  name: string;
}

export const ACTIVITY_DAYS = 180;
export const NOTIFICATION_DAYS = 90;

export const pageTarget = (id: string) => `a:${id}`;
export const projectTarget = (name: string) => `p:${name}`;

/**
 * Users (not `except`) among `ids` who may see the page: the owner, or anyone in an open project
 * or among its members, whom the restrictions on the page and above it let in.
 */
async function mayOpen(db: D1Database, ids: string[], artifactId: string, project: string | null, except: string | undefined): Promise<Set<string>> {
  const wanted = [...new Set(ids)].filter((id) => id !== except);
  if (wanted.length === 0) return new Set();
  const marks = wanted.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `select u.id, u.role from users u where u.id in (${marks}) and (
         u.role = 'root' or ? is null
         or not exists (select 1 from spaces s where s.name = ? and s.access = 'members')
         or exists (select 1 from space_members m where m.space = ? and m.user_id = u.id))`,
    )
    .bind(...wanted, project, project, project)
    .all<{ id: string; role: string }>();
  const audience = await pageAudience(db, artifactId);
  return new Set(results.filter(audience).map((r) => r.id));
}

export interface Happening {
  artifactId: string;
  project: string | null;
  kind: ActivityKind;
  actor: Actor;
  version?: number;
  commentId?: string;
  /** People named in a comment. */
  mentions?: string[];
  /** For a reply or a resolution: people who wrote in the thread. */
  thread?: string[];
}

/** Records what happened and tells whoever it concerns. Returns the activity's id. */
export async function record(db: D1Database, h: Happening): Promise<string> {
  const id = randomId();
  const now = new Date().toISOString();
  const { results: watchers } = await db
    .prepare("select user_id from watches where target in (?, ?)")
    .bind(pageTarget(h.artifactId), h.project ? projectTarget(h.project) : "-")
    .all<{ user_id: string }>();
  // One notification per person, for the most direct reason.
  const reasons = new Map<string, Reason>();
  for (const w of watchers) reasons.set(w.user_id, "watching");
  for (const t of h.thread ?? []) reasons.set(t, "thread");
  for (const m of h.mentions ?? []) reasons.set(m, "mentioned");
  const allowed = await mayOpen(db, [...reasons.keys()], h.artifactId, h.project, h.actor.userId);
  await db.batch([
    db
      .prepare(
        `insert into activity (id, at, artifact_id, project, kind, actor_user, actor_device, actor_name, version, comment_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, now, h.artifactId, h.project, h.kind, h.actor.userId ?? null, h.actor.deviceId ?? null, h.actor.name, h.version ?? null, h.commentId ?? null),
    ...[...reasons]
      .filter(([user]) => allowed.has(user))
      .map(([user, reason]) =>
        db.prepare("insert into notifications (id, user_id, activity_id, reason, created_at) values (?, ?, ?, ?, ?)").bind(randomId(), user, id, reason, now),
      ),
  ]);
  return id;
}

export async function setWatch(db: D1Database, userId: string, target: string, on: boolean): Promise<void> {
  await (on
    ? db.prepare("insert or ignore into watches (user_id, target, created_at) values (?, ?, ?)").bind(userId, target, new Date().toISOString())
    : db.prepare("delete from watches where user_id = ? and target = ?").bind(userId, target)
  ).run();
}

export async function watching(db: D1Database, userId: string, targets: string[]): Promise<Set<string>> {
  if (targets.length === 0) return new Set();
  const { results } = await db
    .prepare(`select target from watches where user_id = ? and target in (${targets.map(() => "?").join(", ")})`)
    .bind(userId, ...targets)
    .all<{ target: string }>();
  return new Set(results.map((r) => r.target));
}

export interface ActivityRow {
  id: string;
  at: string;
  artifact_id: string;
  project: string | null;
  kind: ActivityKind;
  actor_name: string;
  actor_device: string | null;
  version: number | null;
  comment_id: string | null;
  title: string;
  /** The page's project now (project is where it was when this happened). */
  page_project: string | null;
  /** For an agent's doing: the person whose agent it is. */
  agent_of: string | null;
  /** For a comment, a reply or a resolution: the comment's text, and the thread it is in. */
  comment_body?: string | null;
  thread_id?: string | null;
}

/** The parts every feed row joins: the page, the agent's person, the comment and its thread. */
const FEED_JOINS = `join artifacts a on a.id = v.artifact_id
       left join devices d on d.id = v.actor_device left join users du on du.id = d.user_id
       left join comments cm on cm.id = v.comment_id`;
const FEED_COLUMNS = `v.*, a.title, a.project as page_project, du.name as agent_of, cm.body as comment_body, coalesce(cm.reply_to, cm.id) as thread_id`;

/** The newest activity, of one project or one page if given, on pages not in the trash; `before` pages back. */
export async function listActivity(db: D1Database, opts: { project?: string; artifactId?: string; limit?: number; before?: string } = {}): Promise<ActivityRow[]> {
  const where = opts.artifactId ? "and v.artifact_id = ?" : opts.project ? "and v.project = ?" : "";
  const { results } = await db
    .prepare(`select ${FEED_COLUMNS} from activity v ${FEED_JOINS} where a.deleted_at is null ${where} ${opts.before ? "and v.at < ?" : ""} order by v.at desc limit ?`)
    .bind(...(opts.artifactId ? [opts.artifactId] : opts.project ? [opts.project] : []), ...(opts.before ? [opts.before] : []), opts.limit ?? 50)
    .all<ActivityRow>();
  return results;
}

export interface NotificationRow extends ActivityRow {
  notification_id: string;
  reason: Reason;
  read_at: string | null;
}

export async function listNotifications(db: D1Database, userId: string, limit = 100): Promise<NotificationRow[]> {
  const { results } = await db
    .prepare(
      `select n.id as notification_id, n.reason, n.read_at, ${FEED_COLUMNS}
       from notifications n join activity v on v.id = n.activity_id ${FEED_JOINS}
       where n.user_id = ? and a.deleted_at is null order by n.created_at desc limit ?`,
    )
    .bind(userId, limit)
    .all<NotificationRow>();
  return results;
}

export async function markRead(db: D1Database, userId: string, id?: string): Promise<void> {
  const now = new Date().toISOString();
  await (id
    ? db.prepare("update notifications set read_at = coalesce(read_at, ?) where user_id = ? and id = ?").bind(now, userId, id)
    : db.prepare("update notifications set read_at = ? where user_id = ? and read_at is null").bind(now, userId)
  ).run();
}

/**
 * Marks read what a person has now seen of a page: its changes, plus its comments when
 * `comments` is set. Returns how many notifications that was.
 */
export async function markSeen(db: D1Database, userId: string, artifactId: string, opts: { comments?: boolean } = {}): Promise<number> {
  const which = opts.comments ? "" : "and comment_id is null";
  const result = await db
    .prepare(
      `update notifications set read_at = ? where user_id = ? and read_at is null
       and activity_id in (select id from activity where artifact_id = ? ${which})`,
    )
    .bind(new Date().toISOString(), userId, artifactId)
    .run();
  return result.meta.changes ?? 0;
}

/** Where a piece of activity is: the page, at its comment when it is about one. */
export function activityHref(a: Pick<ActivityRow, "artifact_id" | "comment_id" | "thread_id">): string {
  const thread = a.thread_id ?? a.comment_id;
  return thread ? `/a/${a.artifact_id}?comments=1#c-${thread}` : `/a/${a.artifact_id}`;
}

export function cleanupStatements(db: D1Database, now: Date): D1PreparedStatement[] {
  const before = (days: number) => new Date(now.getTime() - days * 864e5).toISOString();
  return [
    db.prepare("delete from activity where at <= ?").bind(before(ACTIVITY_DAYS)),
    db.prepare("delete from notifications where created_at <= ?").bind(before(NOTIFICATION_DAYS)),
  ];
}

/** Pages emptied from the trash lose their activity, its notifications and their watches. */
export function purgeActivityStatements(db: D1Database, cutoff: string): D1PreparedStatement[] {
  const purged = "select id from artifacts where deleted_at is not null and deleted_at <= ?";
  return [
    db.prepare(`delete from notifications where activity_id in (select id from activity where artifact_id in (${purged}))`).bind(cutoff),
    db.prepare(`delete from activity where artifact_id in (${purged})`).bind(cutoff),
    db.prepare(`delete from watches where target in (select 'a:' || id from artifacts where deleted_at is not null and deleted_at <= ?)`).bind(cutoff),
  ];
}
