import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex, utf8 } from "../src/lib/encoding.ts";
import { ORIGIN, createDevice, publish, signedFetch, signedJson, signedRequest, uploadBlob } from "./helpers.ts";

describe("signed requests", () => {
  it("rejects a request without a signature", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/artifacts`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.message).toContain("article login");
  });

  it("rejects a signature from a different key", async () => {
    const device = await createDevice();
    const other = await createDevice();
    const req = await signedRequest(other, "GET", "/api/v1/artifacts");
    const header = req.headers.get("authorization")!.replace(`key=${other.id}`, `key=${device.id}`);
    req.headers.set("authorization", header);
    expect((await SELF.fetch(req)).status).toBe(401);
  });

  it("rejects a replayed request", async () => {
    const device = await createDevice();
    const req = await signedRequest(device, "GET", "/api/v1/artifacts");
    expect((await SELF.fetch(req.clone())).status).toBe(200);
    const again = await SELF.fetch(req);
    expect(again.status).toBe(401);
    expect(((await again.json()) as any).error.code).toBe("replayed");
  });

  it("rejects a stale timestamp", async () => {
    const device = await createDevice();
    const res = await signedFetch(device, "GET", "/api/v1/artifacts", { ts: Math.floor(Date.now() / 1000) - 600 });
    expect(((await res.json()) as any).error.code).toBe("clock_skew");
  });

  it("rejects a body that does not match its declared hash", async () => {
    const device = await createDevice();
    const res = await signedFetch(device, "POST", "/api/v1/blobs/check", {
      body: JSON.stringify({ hashes: [] }),
      contentHash: await sha256Hex("something else"),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a revoked device", async () => {
    const device = await createDevice();
    await env.DB.prepare("update devices set revoked_at = ? where id = ?").bind(new Date().toISOString(), device.id).run();
    expect((await signedFetch(device, "GET", "/api/v1/artifacts")).status).toBe(401);
  });
});

describe("blobs", () => {
  it("stores a blob and reports it as present", async () => {
    const device = await createDevice();
    const hash = await uploadBlob(device, "<p>hello</p>");
    const missingHash = await sha256Hex("not uploaded");
    const res = await signedJson(device, "POST", "/api/v1/blobs/check", { hashes: [hash, missingHash] });
    expect(await res.json()).toEqual({ missing: [missingHash] });
  });

  it("refuses bytes that do not hash to the path", async () => {
    const device = await createDevice();
    const hash = await sha256Hex("expected");
    const bytes = utf8("different");
    const res = await signedFetch(device, "PUT", `/api/v1/blobs/${hash}`, {
      body: bytes,
      contentHash: hash,
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
    });
    expect(res.status).toBe(400);
    expect(await env.BLOBS.head(`blobs/${hash}`)).toBeNull();
  });

  it("refuses a file over 25MB before reading it", async () => {
    const device = await createDevice();
    const hash = await sha256Hex("x");
    const res = await signedFetch(device, "PUT", `/api/v1/blobs/${hash}`, {
      body: utf8("x"),
      contentHash: hash,
      headers: { "content-length": String(26 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
  });
});

describe("publishing", () => {
  it("creates an artifact and serves its metadata", async () => {
    const device = await createDevice();
    const { status, body } = await publish(device, { "index.html": "<h1>v1</h1>", "data.json": "{}" }, { description: "first" });
    expect(status).toBe(201);
    expect(body.version).toBe(1);
    expect(body.url).toBe(`${ORIGIN}/a/${body.id}`);

    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${body.id}`)).json()) as any;
    expect(detail.title).toBe("Test page");
    expect(detail.description).toBe("first");
    expect(Object.keys(detail.versions[0].files).sort()).toEqual(["data.json", "index.html"]);
    expect(detail.versions[0].created_by).toBe(device.id);

    const file = await signedFetch(device, "GET", `/api/v1/artifacts/${body.id}/files/index.html`);
    expect(await file.text()).toBe("<h1>v1</h1>");
  });

  it("updates in place and keeps old versions readable", async () => {
    const device = await createDevice();
    const first = await publish(device, { "index.html": "<h1>v1</h1>" });
    const second = await publish(device, { "index.html": "<h1>v2</h1>" }, { id: first.body.id, base_version: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: first.body.id, version: 2 });

    const old = await signedFetch(device, "GET", `/api/v1/artifacts/${first.body.id}/files/index.html?version=1`);
    expect(await old.text()).toBe("<h1>v1</h1>");
    const latest = await signedFetch(device, "GET", `/api/v1/artifacts/${first.body.id}/files/index.html`);
    expect(await latest.text()).toBe("<h1>v2</h1>");
  });

  it("returns 409 when the base version is stale", async () => {
    const device = await createDevice();
    const first = await publish(device, { "index.html": "a" });
    await publish(device, { "index.html": "b" }, { id: first.body.id, base_version: 1 });
    const stale = await publish(device, { "index.html": "c" }, { id: first.body.id, base_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current_version).toBe(2);
    expect(stale.body.error.message).toContain("Version 2 is the latest");
  });

  it("refuses a manifest that references files that were not uploaded", async () => {
    const device = await createDevice();
    const res = await signedJson(device, "POST", "/api/v1/artifacts", {
      title: "x",
      entry: "index.html",
      files: { "index.html": `sha256:${await sha256Hex("never uploaded")}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("missing_blobs");
  });

  it.each([
    ["../escape.html", ".."],
    ["/abs.html", "relative"],
    ["run.exe", ".exe"],
  ])("refuses the path %s", async (path, reason) => {
    const device = await createDevice();
    const res = await signedJson(device, "POST", "/api/v1/artifacts", {
      title: "x",
      entry: "index.html",
      files: { "index.html": `sha256:${"a".repeat(64)}`, [path]: `sha256:${"b".repeat(64)}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.message).toContain(reason);
  });

  it("refuses a Markdown entry", async () => {
    const device = await createDevice();
    const res = await signedJson(device, "POST", "/api/v1/artifacts", {
      title: "x",
      entry: "README.md",
      files: { "README.md": `sha256:${"a".repeat(64)}` },
    });
    expect(((await res.json()) as any).error.message).toContain(".html");
  });

  it("refuses a bare * in allow_connect", async () => {
    const device = await createDevice();
    const res = await signedJson(device, "POST", "/api/v1/artifacts", {
      title: "x",
      entry: "index.html",
      files: { "index.html": `sha256:${"a".repeat(64)}` },
      allow_connect: ["*"],
    });
    expect(res.status).toBe(400);
  });

  it("moves a deleted artifact to the trash", async () => {
    const device = await createDevice();
    const { body } = await publish(device, { "index.html": "x" });
    expect((await signedFetch(device, "DELETE", `/api/v1/artifacts/${body.id}`)).status).toBe(200);
    expect((await signedFetch(device, "GET", `/api/v1/artifacts/${body.id}`)).status).toBe(404);
    const list = (await (await signedFetch(device, "GET", "/api/v1/artifacts")).json()) as any;
    expect(list.artifacts.map((a: any) => a.id)).not.toContain(body.id);
    const row = await env.DB.prepare("select deleted_at from artifacts where id = ?").bind(body.id).first<{ deleted_at: string }>();
    expect(row?.deleted_at).toBeTruthy();
  });
});
