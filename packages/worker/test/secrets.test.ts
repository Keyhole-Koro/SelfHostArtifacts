import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cleanup } from "../src/cron.ts";
import { loadConfig } from "../src/env.ts";
import { base64url, sha256Hex } from "../src/lib/encoding.ts";
import { ORIGIN, ROOT, browserGet, browserPost, createDevice, sessionCookie, signedFetch, signedJson, type TestDevice } from "./helpers.ts";

async function publicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
}

const ENVELOPE = { v: 1, epk: "", iv: base64url(new Uint8Array(12)), ct: base64url(new Uint8Array(48)) };

async function request(device: TestDevice, body: object = { label: "Mail passwords" }) {
  const res = await signedJson(device, "POST", "/api/v1/secrets", body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string; url: string; expires_at: string };
  const path = new URL(json.url).pathname;
  return { ...json, path };
}

function claim(path: string, public_key: string, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers["origin"] = origin;
  return SELF.fetch(`${ORIGIN}${path}/claim`, { method: "POST", headers, body: JSON.stringify({ public_key }) });
}

async function seal(device: TestDevice, id: string) {
  return signedJson(device, "PUT", `/api/v1/secrets/${id}/sealed`, { envelope: { ...ENVELOPE, epk: await publicKey() } });
}

async function status(device: TestDevice, id: string): Promise<Record<string, unknown>> {
  return (await (await signedFetch(device, "GET", `/api/v1/secrets/${id}`)).json()) as Record<string, unknown>;
}

describe("secret requests", () => {
  it("returns a link once and stores only the hash of its token", async () => {
    const device = await createDevice();
    const { id, url, path, expires_at } = await request(device);
    expect(url).toMatch(/^http:\/\/localhost:8787\/secret\/[A-Za-z0-9_-]{43}$/);
    const token = path.split("/").pop()!;
    const row = await env.DB.prepare("select * from secrets where id = ?").bind(id).first<Record<string, string>>();
    expect(row!["token_hash"]).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(71 * 3600e3);
    expect((await status(device, id))["status"]).toBe("waiting");
  });

  it("refuses an unsigned request and a request longer than 7 days", async () => {
    const unsigned = await SELF.fetch(`${ORIGIN}/api/v1/secrets`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(unsigned.status).toBe(401);
    const device = await createDevice();
    const tooLong = await signedJson(device, "POST", "/api/v1/secrets", { label: "x", expires_in_hours: 169 });
    expect(tooLong.status).toBe(400);
  });

  it("goes from waiting to claimed, sealed and received", async () => {
    const device = await createDevice();
    const { id, path } = await request(device);
    expect((await (await browserGet(`${path}/state`)).json()) as object).toEqual({ status: "waiting", public_key: null });

    // Sealing before anyone opened the link is refused.
    expect((await seal(device, id)).status).toBe(409);

    const key = await publicKey();
    expect((await claim(path, key)).status).toBe(200);
    expect((await (await browserGet(`${path}/state`)).json()) as object).toEqual({ status: "claimed", public_key: key });
    const claimed = await status(device, id);
    expect(claimed["status"]).toBe("claimed");
    expect(claimed["public_key"]).toBe(key);

    expect((await seal(device, id)).status).toBe(200);
    expect((await seal(device, id)).status).toBe(409);
    expect((await status(device, id))["status"]).toBe("sealed");

    const sealed = await browserGet(`${path}/sealed`);
    expect(sealed.status).toBe(200);
    const { envelope } = (await sealed.json()) as { envelope: { v: number; iv: string } };
    expect(envelope.v).toBe(1);
    expect(envelope.iv).toBe(ENVELOPE.iv);
    await browserGet(`${path}/sealed`);
    const opens = await env.DB.prepare("select count(*) as n from audit_events where action = 'secret.open' and target_id = ?").bind(id).first<{ n: number }>();
    expect(opens!.n).toBe(1);

    const done = await SELF.fetch(`${ORIGIN}${path}/received`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    expect(done.status).toBe(200);
    expect((await status(device, id))["status"]).toBe("received");
    const row = await env.DB.prepare("select ciphertext from secrets where id = ?").bind(id).first<{ ciphertext: string | null }>();
    expect(row!.ciphertext).toBeNull();
    expect((await browserGet(path)).status).toBe(404);
    expect((await browserGet(`${path}/sealed`)).status).toBe(404);
  });

  it("lets only the first browser claim, from this origin, with a real P-256 key", async () => {
    const device = await createDevice();
    const { path } = await request(device);
    expect((await claim(path, await publicKey(), null)).status).toBe(403);
    expect((await claim(path, await publicKey(), "null")).status).toBe(403);
    expect((await claim(path, "A".repeat(87))).status).toBe(400); // not a point on the curve
    const first = await publicKey();
    expect((await claim(path, first)).status).toBe(200);
    expect((await claim(path, await publicKey())).status).toBe(409);
    expect(((await (await browserGet(`${path}/state`)).json()) as { public_key: string }).public_key).toBe(first);
  });

  it("answers 404 for an unknown or malformed token", async () => {
    expect((await browserGet(`/secret/${"a".repeat(43)}`)).status).toBe(404);
    expect((await browserGet("/secret/short")).status).toBe(404);
    expect((await claim(`/secret/${"a".repeat(43)}`, await publicKey())).status).toBe(404);
  });

  it("serves the page without sign-in, in the browser's language, and not indexed", async () => {
    const device = await createDevice();
    const { id, path } = await request(device, { label: "メールのパスワード" });
    const en = await browserGet(path);
    expect(en.status).toBe(200);
    expect(en.headers.get("x-robots-tag")).toContain("noindex");
    expect(en.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await en.text();
    expect(html).toContain(`data-id="${id}"`);
    expect(html).toContain("メールのパスワード");
    expect(html).toContain('<script src="/assets/secret.js"');
    expect(html).not.toContain(path.split("/").pop()!);
    const ja = await SELF.fetch(`${ORIGIN}${path}`, { headers: { "accept-language": "ja,en;q=0.8" } });
    expect(await ja.text()).toContain("秘密の受け取り");
    const js = await browserGet("/assets/secret.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("secretCrypto");
  });

  it("can be deleted by the device or the owner, and lists in Settings", async () => {
    const device = await createDevice();
    const a = await request(device, { label: "Deleted by the device" });
    const del = await signedFetch(device, "DELETE", `/api/v1/secrets/${a.id}`);
    expect(((await del.json()) as { status: string }).status).toBe("deleted");
    expect((await browserGet(a.path)).status).toBe(404);

    const owner = await sessionCookie(ROOT);
    const b = await request(device, { label: "Deleted by the owner" });
    const settings = await (await browserGet("/settings", owner.cookie)).text();
    expect(settings).toContain("Deleted by the owner");
    expect(settings).toContain(`/settings/secrets/${b.id}/delete`);
    const res = await browserPost(`/settings/secrets/${b.id}/delete`, owner.cookie, { csrf: owner.csrf });
    expect(res.status).toBe(303);
    expect((await status(device, b.id))["status"]).toBe("deleted");
    // A viewer cannot.
    const viewer = await sessionCookie("viewer");
    expect((await browserPost(`/settings/secrets/${b.id}/delete`, viewer.cookie, { csrf: viewer.csrf })).status).toBe(403);
  });

  it("expires: the link stops working and the daily job drops the ciphertext, then the record", async () => {
    const device = await createDevice();
    const { id, path } = await request(device);
    await claim(path, await publicKey());
    expect((await seal(device, id)).status).toBe(200);
    await env.DB.prepare("update secrets set expires_at = ? where id = ?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    expect((await browserGet(path)).status).toBe(404);
    expect((await browserGet(`${path}/sealed`)).status).toBe(404);
    expect((await status(device, id))["status"]).toBe("expired");

    const config = loadConfig(env);
    await cleanup(env, config);
    const row = await env.DB.prepare("select ciphertext, finished_by from secrets where id = ?").bind(id).first<{ ciphertext: string | null; finished_by: string }>();
    expect(row).toEqual({ ciphertext: null, finished_by: "expiry" });

    await cleanup(env, config, new Date(Date.now() + 31 * 864e5));
    expect(await env.DB.prepare("select id from secrets where id = ?").bind(id).first()).toBeNull();
  });
});
