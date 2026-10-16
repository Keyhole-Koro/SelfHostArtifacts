import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanup } from "../src/cron.ts";
import { loadConfig } from "../src/env.ts";
import { createDevice, publish } from "./helpers.ts";

const DAY = 864e5;

describe("daily cleanup", () => {
  it("purges artifacts that have been in the trash for TRASH_DAYS, and their unused blobs", async () => {
    const device = await createDevice();
    const kept = await publish(device, { "index.html": "kept" });
    const trashed = await publish(device, { "index.html": "trashed only" });
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?").bind(new Date(Date.now() - 31 * DAY).toISOString(), trashed.body.id).run();

    const report = await cleanup(env, loadConfig(env), new Date(Date.now() + 2 * DAY));
    expect(report.purgedArtifacts).toBe(1);
    expect(await env.DB.prepare("select 1 from artifacts where id = ?").bind(trashed.body.id).first()).toBeNull();
    expect(await env.DB.prepare("select 1 from artifacts where id = ?").bind(kept.body.id).first()).not.toBeNull();
    expect(report.deletedBlobs).toBe(1);
  });

  it("keeps recently trashed artifacts", async () => {
    const device = await createDevice();
    const { body } = await publish(device, { "index.html": "recent" });
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?").bind(new Date().toISOString(), body.id).run();
    const report = await cleanup(env, loadConfig(env));
    expect(report.purgedArtifacts).toBe(0);
  });

  it("keeps blobs uploaded in the last day even when nothing references them yet", async () => {
    await env.BLOBS.put("blobs/" + "c".repeat(64), "in flight");
    const report = await cleanup(env, loadConfig(env));
    expect(report.deletedBlobs).toBe(0);
  });

  it("prunes to KEEP_VERSIONS and never drops the current version", async () => {
    const device = await createDevice();
    const first = await publish(device, { "index.html": "1" });
    await publish(device, { "index.html": "2" }, { id: first.body.id, base_version: 1 });
    await publish(device, { "index.html": "3" }, { id: first.body.id, base_version: 2 });
    const report = await cleanup(env, { ...loadConfig(env), keepVersions: 2 });
    expect(report.prunedVersions).toBe(1);
    const { results } = await env.DB.prepare("select version from versions where artifact_id = ? order by version").bind(first.body.id).all();
    expect(results.map((r) => r["version"])).toEqual([2, 3]);
  });

  it("removes expired nonces and sessions", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("insert into nonces (nonce, expires_at) values ('n1', ?)").bind(past).run();
    await env.DB.prepare("insert into sessions (id, email, csrf, expires_at) values ('s1', 'a@example.com', 'c', ?)").bind(past).run();
    const report = await cleanup(env, loadConfig(env));
    expect(report.expired).toBeGreaterThanOrEqual(2);
  });
});
