import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { chunksOf, forgetPages, hybridSearch, indexPage, indexPending, type Embedder, type VectorStore } from "../src/db/semantic.ts";
import { createDevice, publish, signedFetch } from "./helpers.ts";

// Stand-ins: words that mean the same thing point the same way, so meaning differs from wording.
const CONCEPTS = [
  ["passkey", "パスキー", "ログインの鍵", "sign-in key"],
  ["ring", "リング", "queue", "待ち行列"],
  ["deploy", "デプロイ", "本番に出す", "release"],
  ["banana", "バナナ"],
];
function embed(text: string): number[] {
  const v = CONCEPTS.map((words) => words.reduce((n, w) => n + text.toLowerCase().split(w.toLowerCase()).length - 1, 0));
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
function fakeAI(fail = false): Embedder & { calls: number } {
  return {
    calls: 0,
    async run(_model, input) {
      this.calls++;
      if (fail) throw new Error("4006: you have used up your daily free allocation");
      return { shape: [input.text.length, CONCEPTS.length], data: input.text.map(embed) };
    },
  };
}
function fakeIndex(): VectorStore & { vectors: Map<string, number[]> } {
  const vectors = new Map<string, number[]>();
  return {
    vectors,
    async upsert(vs) { for (const v of vs) vectors.set(v.id, v.values); },
    async deleteByIds(ids) { for (const id of ids) vectors.delete(id); },
    async query(q, { topK }) {
      const dot = (a: number[]) => a.reduce((n, x, k) => n + x * q[k]!, 0);
      return { matches: [...vectors].map(([id, v]) => ({ id, score: dot(v) })).sort((a, b) => b.score - a.score).slice(0, topK) };
    },
  };
}

describe("search by meaning", () => {
  it("cuts a page into passages: lines packed together, a long line cut where a sentence ends, sixteen at most", () => {
    expect(chunksOf("Title\nshort one\nshort two")).toEqual(["Title\nshort one\nshort two"]);
    const long = "これは長い文です。".repeat(150);
    const parts = chunksOf(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 800 && p.endsWith("。"))).toBe(true);
    expect(chunksOf(Array.from({ length: 100 }, (_, k) => `line ${k} `.repeat(60)).join("\n")).length).toBe(16);
  });

  it("indexes a page once per version and forgets passages a shorter version no longer has", async () => {
    const device = await createDevice();
    const AI = fakeAI(), VECTORS = fakeIndex();
    const sem = { DB: env.DB, AI, VECTORS };
    const page = await publish(device, { "index.html": "<p>x</p>" }, { title: "Long page", text: Array.from({ length: 3 }, (_, k) => `paragraph ${k} `.repeat(70)).join("\n") });
    expect(await indexPage(sem, page.body.id)).toBe(true);
    const first = [...VECTORS.vectors.keys()].filter((k) => k.startsWith(page.body.id));
    expect(first.length).toBeGreaterThan(1);
    expect(await indexPage(sem, page.body.id)).toBe(false);
    await publish(device, { "index.html": "<p>y</p>" }, { id: page.body.id, title: "Long page", text: "short now" });
    expect(await indexPage(sem, page.body.id)).toBe(true);
    expect([...VECTORS.vectors.keys()].filter((k) => k.startsWith(page.body.id))).toEqual([`${page.body.id}:0`]);
    await forgetPages(sem, [page.body.id]);
    expect([...VECTORS.vectors.keys()].filter((k) => k.startsWith(page.body.id))).toEqual([]);
  });

  it("finds a page that says the same thing in other words, merged with the pages that have the words", async () => {
    const device = await createDevice();
    const AI = fakeAI(), VECTORS = fakeIndex();
    const sem = { DB: env.DB, AI, VECTORS };
    const worded = await publish(device, { "index.html": "<p>x</p>" }, { title: "Passkey setup", text: "Register a passkey on each laptop" });
    const reworded = await publish(device, { "index.html": "<p>x</p>" }, { title: "Adding a device", text: "ログインの鍵をもう 1 つ足す手順" });
    const unrelated = await publish(device, { "index.html": "<p>x</p>" }, { title: "Fruit", text: "バナナは黄色い" });
    for (const p of [worded, reworded, unrelated]) await indexPage(sem, p.body.id);
    const hits = await hybridSearch(sem, "passkey", 20);
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get(worded.body.id)?.match).toBe("both");
    expect(byId.get(reworded.body.id)?.match).toBe("meaning");
    expect(byId.get(reworded.body.id)?.snippet).toContain("ログインの鍵");
    expect(byId.has(unrelated.body.id)).toBe(false);
    expect(hits[0]!.id).toBe(worded.body.id);
    // A page in the trash is not found by meaning either.
    await signedFetch(device, "DELETE", `/api/v1/artifacts/${reworded.body.id}`);
    expect((await hybridSearch(sem, "passkey", 20)).map((h) => h.id)).not.toContain(reworded.body.id);
  });

  it("answers from words alone when Workers AI refuses, and indexes what is pending a batch at a time", async () => {
    const device = await createDevice();
    const page = await publish(device, { "index.html": "<p>x</p>" }, { title: "Deploy notes", text: "how to deploy" });
    const refusing = { DB: env.DB, AI: fakeAI(true), VECTORS: fakeIndex() };
    const hits = await hybridSearch(refusing, "deploy", 20);
    expect(hits.find((h) => h.id === page.body.id)?.match).toBe("words");
    const working = { DB: env.DB, AI: fakeAI(), VECTORS: fakeIndex() };
    const before = await indexPending(working);
    expect(before.indexed).toBeGreaterThan(0);
    expect(before.indexed).toBeLessThanOrEqual(10);
    expect(before.total).toBeGreaterThan(0);
  });
});
