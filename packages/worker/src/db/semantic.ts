/**
 * Search by meaning. A page's title and text are cut into passages, Workers AI turns each into a
 * vector (bge-m3: multilingual, 1,024 numbers), and a Vectorize index keeps them under
 * "<artifact id>:<n>". A query is embedded the same way and its nearest passages name pages.
 * The results are merged with the word search, so both kinds of match count.
 *
 * Everything here is optional: without the AI and VECTORS bindings, or when Workers AI refuses
 * (the free plan's daily allowance is used up), search answers from words alone.
 */
import { searchPages, type SearchHit } from "./search.ts";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const DIMENSIONS = 1024;
export const VECTOR_INDEX = "artifacts-pages";
/** A passage is about this long; a page keeps at most this many (about 12,800 characters). */
const CHUNK_CHARS = 800;
const MAX_CHUNKS = 16;
/** Nearest passages scoring below this are not related enough to show. */
export const MIN_SCORE = 0.5;
/** Pages embedded in one go: each takes a few calls, and a request may make only so many. */
export const INDEX_BATCH = 10;

/** The parts of the AI and Vectorize bindings used here, so tests can stand in for them. */
export interface Embedder {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}
export interface VectorStore {
  upsert(vectors: { id: string; values: number[] }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], options: { topK: number; returnMetadata?: "none" }): Promise<{ matches: { id: string; score: number }[] }>;
}
export interface SemanticEnv {
  DB: D1Database;
  AI?: Embedder;
  VECTORS?: VectorStore;
}

export function semanticOn(env: SemanticEnv): env is SemanticEnv & { AI: Embedder; VECTORS: VectorStore } {
  return !!env.AI && !!env.VECTORS;
}

/** The passages of a page: its lines packed up to CHUNK_CHARS, a long line cut where a sentence ends. */
export function chunksOf(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let rest = line;
    while (rest.length > CHUNK_CHARS) {
      const window = rest.slice(0, CHUNK_CHARS);
      const cut = Math.max(window.lastIndexOf("。"), window.lastIndexOf(". "), window.lastIndexOf("　"), window.lastIndexOf(" "));
      const at = cut > CHUNK_CHARS / 2 ? cut + 1 : CHUNK_CHARS;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > CHUNK_CHARS) {
      out.push(current);
      if (out.length === MAX_CHUNKS) return out;
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out.slice(0, MAX_CHUNKS);
}

function vectorsOf(output: unknown): number[][] {
  const data = (output as { data?: unknown }).data;
  if (!Array.isArray(data) || !data.every((v) => Array.isArray(v))) throw new Error("Workers AI returned no embeddings");
  return data as number[][];
}

/**
 * Embeds a page's current title and text into the index, and forgets passages it no longer has.
 * Returns false when there is nothing to do (no such page, or it is up to date).
 */
export async function indexPage(env: SemanticEnv & { AI: Embedder; VECTORS: VectorStore }, id: string): Promise<boolean> {
  const page = await env.DB
    .prepare(
      `select a.id, a.title, a.current_version, coalesce(t.body, '') as body, v.version as indexed, v.chunks as had
       from artifacts a left join page_text t on t.id = a.id left join page_vectors v on v.artifact_id = a.id
       where a.id = ? and a.deleted_at is null`,
    )
    .bind(id)
    .first<{ id: string; title: string; current_version: number; body: string; indexed: number | null; had: number | null }>();
  if (!page || page.indexed === page.current_version) return false;
  const chunks = chunksOf(`${page.title}\n${page.body}`);
  if (chunks.length === 0) chunks.push(page.title);
  const vectors = vectorsOf(await env.AI.run(EMBED_MODEL, { text: chunks }));
  await env.VECTORS.upsert(vectors.map((values, n) => ({ id: `${id}:${n}`, values })));
  if ((page.had ?? 0) > chunks.length) {
    await env.VECTORS.deleteByIds(Array.from({ length: page.had! - chunks.length }, (_, k) => `${id}:${chunks.length + k}`));
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("delete from page_chunks where artifact_id = ?").bind(id),
    ...chunks.map((text, n) => env.DB.prepare("insert into page_chunks (artifact_id, n, text) values (?, ?, ?)").bind(id, n, text)),
    env.DB
      .prepare(
        `insert into page_vectors (artifact_id, version, chunks, indexed_at) values (?, ?, ?, ?)
         on conflict (artifact_id) do update set version = excluded.version, chunks = excluded.chunks, indexed_at = excluded.indexed_at`,
      )
      .bind(id, page.current_version, chunks.length, now),
  ]);
  return true;
}

/** Embeds a page in the background, logging instead of failing the request that changed it. */
export function indexLater(env: SemanticEnv, ctx: { waitUntil(p: Promise<unknown>): void }, id: string): void {
  if (!semanticOn(env)) return;
  ctx.waitUntil(indexPage(env, id).catch((e) => console.log("semantic index", id, String(e))));
}

/** Pages whose vectors are missing or older than their current version. */
export async function pendingPages(db: D1Database, limit: number): Promise<{ ids: string[]; left: number; total: number }> {
  const where = `from artifacts a left join page_vectors v on v.artifact_id = a.id
                 where a.deleted_at is null and (v.version is null or v.version != a.current_version)`;
  const [rows, counts] = await db.batch([
    db.prepare(`select a.id ${where} order by a.updated_at desc limit ?`).bind(limit),
    db.prepare(`select (select count(*) ${where}) as left, (select count(*) from artifacts where deleted_at is null) as total`),
  ]);
  const c = (counts!.results as { left: number; total: number }[])[0]!;
  return { ids: (rows!.results as { id: string }[]).map((r) => r.id), left: c.left, total: c.total };
}

/** Embeds up to INDEX_BATCH pending pages; how many it did and how many are still waiting. */
export async function indexPending(env: SemanticEnv & { AI: Embedder; VECTORS: VectorStore }): Promise<{ indexed: number; left: number; total: number }> {
  const { ids, left, total } = await pendingPages(env.DB, INDEX_BATCH);
  let indexed = 0;
  for (const id of ids) if (await indexPage(env, id)) indexed++;
  return { indexed, left: Math.max(0, left - indexed), total };
}

/** Forgets the vectors of pages that are being deleted for good. */
export async function forgetPages(env: SemanticEnv, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(`select artifact_id, chunks from page_vectors where artifact_id in (${marks})`).bind(...ids).all<{ artifact_id: string; chunks: number }>();
  const vectorIds = results.flatMap((r) => Array.from({ length: r.chunks }, (_, n) => `${r.artifact_id}:${n}`));
  if (env.VECTORS && vectorIds.length) await env.VECTORS.deleteByIds(vectorIds);
  await env.DB.batch([
    env.DB.prepare(`delete from page_chunks where artifact_id in (${marks})`).bind(...ids),
    env.DB.prepare(`delete from page_vectors where artifact_id in (${marks})`).bind(...ids),
  ]);
}

export interface HybridHit extends SearchHit {
  /** words: found by the word search; meaning: only by meaning; both. */
  match: "words" | "meaning" | "both";
}

/**
 * The word search and the search by meaning, merged by reciprocal rank: a page high in either
 * list ranks high, and one in both ranks higher.
 */
export async function hybridSearch(env: SemanticEnv, query: string, limit = 50): Promise<HybridHit[]> {
  const words = await searchPages(env.DB, query, limit);
  if (!query.trim() || !semanticOn(env)) return words.map((h) => ({ ...h, match: "words" }));
  let meaning: { id: string; n: number; score: number }[] = [];
  try {
    const [vector] = vectorsOf(await env.AI.run(EMBED_MODEL, { text: [query.trim().slice(0, 500)] }));
    const { matches } = await env.VECTORS.query(vector!, { topK: 40, returnMetadata: "none" });
    const best = new Map<string, { id: string; n: number; score: number }>();
    for (const m of matches) {
      const [id, n] = m.id.split(":");
      if (!id || m.score < MIN_SCORE || best.has(id)) continue;
      best.set(id, { id, n: Number(n), score: m.score });
    }
    meaning = [...best.values()];
  } catch (e) {
    console.log("semantic search", String(e));
    return words.map((h) => ({ ...h, match: "words" }));
  }
  const score = new Map<string, number>();
  words.forEach((h, k) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (60 + k)));
  meaning.forEach((h, k) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (60 + k)));
  const byWords = new Map(words.map((h) => [h.id, h]));
  const extra = meaning.filter((m) => !byWords.has(m.id));
  const found = new Map<string, SearchHit>();
  if (extra.length) {
    // The pages found only by meaning, with the passage that matched as their excerpt.
    const marks = extra.map(() => "(?, ?)").join(", ");
    const { results } = await env.DB
      .prepare(
        `with wanted(id, n) as (values ${marks})
         select a.id, a.title, a.description, a.project, a.updated_at, substr(c.text, 1, 200) as snippet
         from wanted w join artifacts a on a.id = w.id left join page_chunks c on c.artifact_id = w.id and c.n = w.n
         where a.deleted_at is null`,
      )
      .bind(...extra.flatMap((m) => [m.id, m.n]))
      .all<SearchHit>();
    for (const r of results) found.set(r.id, { ...r, snippet: r.snippet ?? "" });
  }
  const meaningIds = new Set(meaning.map((m) => m.id));
  const hits: HybridHit[] = [
    ...words.map((h) => ({ ...h, match: meaningIds.has(h.id) ? ("both" as const) : ("words" as const) })),
    ...extra.flatMap((m) => (found.has(m.id) ? [{ ...found.get(m.id)!, match: "meaning" as const }] : [])),
  ];
  return hits.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0)).slice(0, limit);
}
