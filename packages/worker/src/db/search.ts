/**
 * Search over pages' titles, descriptions and text, and the links between pages. Both describe
 * the current version: publishing replaces them. Pages in the trash stay indexed until they are
 * purged, and every query leaves them out.
 */

/** Statements that make the index describe a page's current version. `text` undefined keeps the old text. */
export function indexStatements(db: D1Database, id: string, page: { title: string; description: string | null; text?: string }): D1PreparedStatement[] {
  if (page.text === undefined) {
    return [
      db
        .prepare(
          `insert into page_text (id, title, description, body)
           select ?, ?, ?, coalesce((select body from page_text where id = ?), '')`,
        )
        .bind(id, page.title, page.description ?? "", id),
      db.prepare("delete from page_text where id = ? and rowid != (select max(rowid) from page_text where id = ?)").bind(id, id),
    ];
  }
  return [
    db.prepare("delete from page_text where id = ?").bind(id),
    db.prepare("insert into page_text (id, title, description, body) values (?, ?, ?, ?)").bind(id, page.title, page.description ?? "", page.text),
  ];
}

export function linkStatements(db: D1Database, from: string, to: string[] | undefined): D1PreparedStatement[] {
  if (to === undefined) return [];
  return [
    db.prepare("delete from links where from_id = ?").bind(from),
    ...[...new Set(to)].filter((t) => t !== from).map((t) => db.prepare("insert or ignore into links (from_id, to_id) values (?, ?)").bind(from, t)),
  ];
}

export interface LinkedPage {
  id: string;
  title: string;
  project: string | null;
}

/** Pages (not in the trash) that link to `id`. */
export async function linkedFrom(db: D1Database, id: string): Promise<LinkedPage[]> {
  const { results } = await db
    .prepare("select a.id, a.title, a.project from links l join artifacts a on a.id = l.from_id where l.to_id = ? and a.deleted_at is null order by a.title")
    .bind(id)
    .all<LinkedPage>();
  return results;
}

/** Pages (not in the trash) that `id` links to. */
export async function linksTo(db: D1Database, id: string): Promise<LinkedPage[]> {
  const { results } = await db
    .prepare("select a.id, a.title, a.project from links l join artifacts a on a.id = l.to_id where l.from_id = ? and a.deleted_at is null order by a.title")
    .bind(id)
    .all<LinkedPage>();
  return results;
}

export interface SearchHit {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  updated_at: string;
  /** Text around the match, with each match between \u0001 and \u0002. */
  snippet: string;
}

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

/**
 * Pages whose title, description or text has every word of `query` (in any order). A word under 3
 * characters cannot use the trigram index, so a query with one is answered by a slower scan.
 */
export async function searchPages(db: D1Database, query: string, limit = 50): Promise<SearchHit[]> {
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) return [];
  if (words.every((w) => [...w].length >= 3)) {
    const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
    const { results } = await db
      .prepare(
        `select a.id, a.title, a.description, a.project, a.updated_at,
                snippet(page_text, -1, ?, ?, '…', 24) as snippet
         from page_text join artifacts a on a.id = page_text.id
         where page_text match ? and a.deleted_at is null
         order by bm25(page_text, 0, 10, 4, 1) limit ?`,
      )
      .bind(MARK_START, MARK_END, match, limit)
      .all<SearchHit>();
    return results;
  }
  // Short words: every word somewhere in the title, description or text.
  const like = words.map(() => "(p.title like ? escape '\\' or p.description like ? escape '\\' or p.body like ? escape '\\')").join(" and ");
  const patterns = words.flatMap((w) => {
    const p = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return [p, p, p];
  });
  const first = words[0]!;
  const { results } = await db
    .prepare(
      `select a.id, a.title, a.description, a.project, a.updated_at,
              substr(p.body, max(instr(p.body, ?) - 60, 1), 160) as snippet
       from page_text p join artifacts a on a.id = p.id
       where ${like} and a.deleted_at is null
       order by a.updated_at desc limit ?`,
    )
    .bind(first, ...patterns, limit)
    .all<SearchHit>();
  return results.map((r) => ({ ...r, snippet: markAll(r.snippet ?? "", words) }));
}

function markAll(text: string, words: string[]): string {
  let out = text;
  for (const w of words) out = out.split(w).join(`${MARK_START}${w}${MARK_END}`);
  return out;
}

/** Statements that forget purged pages. */
export function purgeStatements(db: D1Database, cutoff: string): D1PreparedStatement[] {
  const purged = "select id from artifacts where deleted_at is not null and deleted_at <= ?";
  return [
    db.prepare(`delete from page_text where id in (${purged})`).bind(cutoff),
    db.prepare(`delete from links where from_id in (${purged}) or to_id in (${purged})`).bind(cutoff, cutoff),
  ];
}
