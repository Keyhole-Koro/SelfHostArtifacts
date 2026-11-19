/** Labels on pages. Setting a page's labels replaces them all. */
import { MAX_LABELS, labelSchema } from "@artifact/shared";
import { hybridSearch, type HybridHit, type SemanticEnv } from "./semantic.ts";
import type { Access } from "./access.ts";

export function setLabelsStatements(db: D1Database, id: string, labels: string[]): D1PreparedStatement[] {
  return [
    db.prepare("delete from labels where artifact_id = ?").bind(id),
    ...[...new Set(labels)].map((l) => db.prepare("insert into labels (artifact_id, label) values (?, ?)").bind(id, l)),
  ];
}

/** Labels of each of these pages. */
export async function labelsOf(db: D1Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  // D1 binds at most 100 parameters, so ask in slices.
  for (let k = 0; k < ids.length; k += 90) {
    const part = ids.slice(k, k + 90);
    const { results } = await db
      .prepare(`select artifact_id, label from labels where artifact_id in (${part.map(() => "?").join(", ")}) order by label`)
      .bind(...part)
      .all<{ artifact_id: string; label: string }>();
    for (const r of results) {
      if (!out.has(r.artifact_id)) out.set(r.artifact_id, []);
      out.get(r.artifact_id)!.push(r.label);
    }
  }
  return out;
}

/** The pages (not in the trash) with a label. */
export async function pagesWithLabel(db: D1Database, label: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("select l.artifact_id from labels l join artifacts a on a.id = l.artifact_id where l.label = ? and a.deleted_at is null")
    .bind(label)
    .all<{ artifact_id: string }>();
  return new Set(results.map((r) => r.artifact_id));
}

/** Every label in use, with how many pages have it, the most used first. */
export async function allLabels(db: D1Database): Promise<{ label: string; count: number }[]> {
  const { results } = await db
    .prepare("select l.label, count(*) as count from labels l join artifacts a on a.id = l.artifact_id where a.deleted_at is null group by l.label order by count desc, l.label")
    .all<{ label: string; count: number }>();
  return results;
}

/** Pages emptied from the trash lose their labels. */
export function purgeLabelStatements(db: D1Database, cutoff: string): D1PreparedStatement[] {
  return [db.prepare("delete from labels where artifact_id in (select id from artifacts where deleted_at is not null and deleted_at <= ?)").bind(cutoff)];
}

/** Adds and removes labels on a page, keeping at most MAX_LABELS. Returns the page's labels. */
export async function changeLabels(db: D1Database, id: string, change: { set?: string[]; add?: string[]; remove?: string[] }): Promise<string[]> {
  const now = (await labelsOf(db, [id])).get(id) ?? [];
  const removed = new Set(change.remove ?? []);
  const next = [...new Set([...(change.set ?? now), ...(change.add ?? [])])].filter((l) => !removed.has(l)).slice(0, MAX_LABELS);
  await db.batch(setLabelsStatements(db, id, next));
  return next.sort();
}

/**
 * Every label in use on the pages one may see, with how many pages have it, the most used first:
 * of one project if given (null: the pages without one), else of all.
 */
export async function labelCounts(db: D1Database, access: Access, project?: string | null): Promise<{ label: string; count: number }[]> {
  const { results } = await db
    .prepare("select l.label, l.artifact_id as id, a.project from labels l join artifacts a on a.id = l.artifact_id where a.deleted_at is null")
    .all<{ label: string; id: string; project: string | null }>();
  const counts = new Map<string, number>();
  for (const r of results) {
    if (!access.sees(r)) continue;
    if (project !== undefined && r.project !== project) continue;
    counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** `label:x` words in a search are labels a page must have; the rest is searched as usual. */
export function splitLabels(q: string): { labels: string[]; rest: string } {
  const labels: string[] = [];
  const rest = q
    .replace(/(^|\s)label:(\S+)/giu, (_m, space: string, l: string) => {
      const parsed = labelSchema.safeParse(l);
      if (parsed.success) labels.push(parsed.data);
      return space;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { labels: [...new Set(labels)], rest };
}

/** The search, with `label:x` words narrowing it to pages with those labels (alone, they list the pages). */
export async function labeledSearch(env: SemanticEnv, q: string, limit: number): Promise<HybridHit[]> {
  const { labels, rest } = splitLabels(q);
  if (labels.length === 0) return hybridSearch(env, q, limit);
  const marks = labels.map(() => "?").join(", ");
  const having = `select artifact_id from labels where label in (${marks}) group by artifact_id having count(*) = ${labels.length}`;
  if (!rest) {
    const { results } = await env.DB
      .prepare(
        `select a.id, a.title, a.description, a.project, a.updated_at from artifacts a
         where a.deleted_at is null and a.id in (${having}) order by a.updated_at desc limit ?`,
      )
      .bind(...labels, limit)
      .all<{ id: string; title: string; description: string | null; project: string | null; updated_at: string }>();
    return results.map((r) => ({ ...r, snippet: r.description ?? "", match: "words" as const }));
  }
  const { results } = await env.DB.prepare(having).bind(...labels).all<{ artifact_id: string }>();
  const allowed = new Set(results.map((r) => r.artifact_id));
  return (await hybridSearch(env, rest, 200)).filter((h) => allowed.has(h.id)).slice(0, limit);
}
