import { randomId } from "../lib/encoding.ts";

/** Comments on a page, in threads: a comment with reply_to null starts one, replies point at it. */
export interface CommentRow {
  id: string;
  artifact_id: string;
  version: number;
  reply_to: string | null;
  author_user: string | null;
  author_device: string | null;
  author_name: string;
  body: string;
  quote: string | null;
  resolved_at: string | null;
  created_at: string;
}

export const MAX_COMMENT_CHARS = 4000;
export const MAX_QUOTE_CHARS = 500;

export interface Thread {
  first: CommentRow;
  replies: CommentRow[];
}

export async function listComments(db: D1Database, artifactId: string): Promise<CommentRow[]> {
  const { results } = await db.prepare("select * from comments where artifact_id = ? order by created_at, id").bind(artifactId).all<CommentRow>();
  return results;
}

/** Threads, oldest first, each with its replies. */
export function threadsOf(rows: CommentRow[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const r of rows) if (!r.reply_to) threads.set(r.id, { first: r, replies: [] });
  for (const r of rows) if (r.reply_to) threads.get(r.reply_to)?.replies.push(r);
  return [...threads.values()];
}

export async function getComment(db: D1Database, id: string): Promise<CommentRow | null> {
  return db.prepare("select * from comments where id = ?").bind(id).first<CommentRow>();
}

export async function addComment(
  db: D1Database,
  c: Pick<CommentRow, "artifact_id" | "version" | "reply_to" | "author_user" | "author_device" | "author_name" | "body" | "quote">,
): Promise<string> {
  const id = randomId();
  await db
    .prepare(
      `insert into comments (id, artifact_id, version, reply_to, author_user, author_device, author_name, body, quote, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, c.artifact_id, c.version, c.reply_to, c.author_user, c.author_device, c.author_name, c.body, c.quote, new Date().toISOString())
    .run();
  return id;
}

export async function setResolved(db: D1Database, threadId: string, resolved: boolean): Promise<void> {
  await db.prepare("update comments set resolved_at = ? where id = ? and reply_to is null").bind(resolved ? new Date().toISOString() : null, threadId).run();
}

/** Deletes a comment; deleting a thread's first comment deletes the thread. */
export async function deleteComment(db: D1Database, id: string): Promise<void> {
  await db.batch([db.prepare("delete from comments where reply_to = ?").bind(id), db.prepare("delete from comments where id = ?").bind(id)]);
}

/** Open (unresolved) threads per page. */
export async function openThreadCounts(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("select artifact_id, count(*) as n from comments where reply_to is null and resolved_at is null group by artifact_id")
    .all<{ artifact_id: string; n: number }>();
  return new Map(results.map((r) => [r.artifact_id, r.n]));
}

export function purgeCommentStatements(db: D1Database, cutoff: string): D1PreparedStatement[] {
  return [db.prepare("delete from comments where artifact_id in (select id from artifacts where deleted_at is not null and deleted_at <= ?)").bind(cutoff)];
}

/** The people (not agents) who wrote in a thread, given its first comment. */
export async function threadPeople(db: D1Database, threadId: string): Promise<string[]> {
  const { results } = await db
    .prepare("select distinct author_user from comments where (id = ? or reply_to = ?) and author_user is not null")
    .bind(threadId, threadId)
    .all<{ author_user: string }>();
  return results.map((r) => r.author_user);
}
