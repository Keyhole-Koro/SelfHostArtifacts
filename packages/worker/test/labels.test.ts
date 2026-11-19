import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { browserGet, browserPost, createDevice, publish, sessionCookie, signedFetch, signedJson, type TestDevice } from "./helpers.ts";
import { splitLabels } from "../src/db/labels.ts";

const PAGE = { "index.html": "<p>hi</p>" };

async function call<T>(device: TestDevice, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = body === undefined ? await signedFetch(device, method, path) : await signedJson(device, method, path, body);
  return { status: res.status, body: (await res.json()) as T };
}

describe("labels", () => {
  it("are set when publishing, kept when an update leaves them out, and listed with the page", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "Choosing a database", labels: ["Decision", "decision", "storage notes"] });
    expect(page.status).toBe(201);
    let detail = await call<{ labels: string[] }>(device, "GET", `/api/v1/artifacts/${page.body.id}`);
    expect(detail.body.labels).toEqual(["decision", "storage-notes"]);
    await publish(device, PAGE, { id: page.body.id, title: "Choosing a database" });
    detail = await call<{ labels: string[] }>(device, "GET", `/api/v1/artifacts/${page.body.id}`);
    expect(detail.body.labels).toEqual(["decision", "storage-notes"]);
    const listed = await call<{ artifacts: { id: string; labels: string[] }[] }>(device, "GET", "/api/v1/artifacts?label=decision");
    expect(listed.body.artifacts.map((a) => a.id)).toEqual([page.body.id]);
    const bad = await publish(device, PAGE, { title: "Bad", labels: ["no/slash"] });
    expect(bad.status).toBe(400);
  });

  it("change through the API and narrow a search with label:", async () => {
    const device = await createDevice();
    const a = await publish(device, PAGE, { title: "Queue plan", text: "how the queue drains" });
    const b = await publish(device, PAGE, { title: "Queue notes", text: "how the queue fills" });
    const changed = await call<{ labels: string[] }>(device, "POST", `/api/v1/artifacts/${a.body.id}/labels`, { add: ["plan", "draft"] });
    expect(changed.body.labels).toEqual(["draft", "plan"]);
    const removed = await call<{ labels: string[] }>(device, "POST", `/api/v1/artifacts/${a.body.id}/labels`, { remove: ["draft"] });
    expect(removed.body.labels).toEqual(["plan"]);
    const words = await call<{ results: { id: string }[] }>(device, "GET", `/api/v1/search?q=${encodeURIComponent("queue label:plan")}`);
    expect(words.body.results.map((r) => r.id)).toEqual([a.body.id]);
    const only = await call<{ results: { id: string }[] }>(device, "GET", `/api/v1/search?q=${encodeURIComponent("label:plan")}`);
    expect(only.body.results.map((r) => r.id)).toEqual([a.body.id]);
    const both = await call<{ results: { id: string }[] }>(device, "GET", "/api/v1/search?q=queue");
    expect(both.body.results.map((r) => r.id).sort()).toEqual([a.body.id, b.body.id].sort());
  });

  it("are added and removed by editors in the browser, and filter the list", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "LabelDocs", title: "Runbook" });
    const owner = await sessionCookie("root");
    const added = await browserPost(`/a/${page.body.id}/labels`, owner.cookie, { csrf: owner.csrf, add: "ops, Runbook" });
    expect(added.status).toBe(303);
    const viewer = await (await browserGet(`/a/${page.body.id}`, owner.cookie)).text();
    expect(viewer).toContain('href="/?label=ops"');
    expect(viewer).toContain('href="/?label=runbook"');
    const list = await (await browserGet("/?label=ops", owner.cookie)).text();
    expect(list).toContain(`/a/${page.body.id}`);
    expect(list).toContain("labeled ops");
    await browserPost(`/a/${page.body.id}/labels/remove`, owner.cookie, { csrf: owner.csrf, label: "ops" });
    expect(await (await browserGet("/?label=ops", owner.cookie)).text()).not.toContain(`/a/${page.body.id}`);
    // Someone who may only read the page cannot label it.
    const reader = await sessionCookie("viewer");
    const refused = await browserPost(`/a/${page.body.id}/labels`, reader.cookie, { csrf: reader.csrf, add: "mine" });
    expect(refused.status).toBe(403);
    const search = await (await browserGet(`/search?q=${encodeURIComponent("label:runbook")}`, owner.cookie)).text();
    expect(search).toContain(`/a/${page.body.id}`);
  });

  it("take label: words out of a search", () => {
    expect(splitLabels("queue label:Plan  drains label:bad/one")).toEqual({ labels: ["plan"], rest: "queue drains" });
    expect(splitLabels("label:a label:a")).toEqual({ labels: ["a"], rest: "" });
  });

  it("go when a page is emptied from the trash", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "Old", labels: ["gone"] });
    await env.DB.prepare("update artifacts set deleted_at = '2000-01-01T00:00:00.000Z' where id = ?").bind(page.body.id).run();
    const { cleanup } = await import("../src/cron.ts");
    const { loadConfig } = await import("../src/env.ts");
    await cleanup(env, loadConfig(env));
    expect(await env.DB.prepare("select count(*) as n from labels where artifact_id = ?").bind(page.body.id).first<{ n: number }>()).toEqual({ n: 0 });
  });
});
