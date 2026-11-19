import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64url } from "../src/lib/encoding.ts";
import { createDevice, signedFetch, signedJson, type TestDevice } from "./helpers.ts";

/**
 * Delivery targets and records. The crypto is covered by vault.test.ts; here the envelopes only
 * need the right shape, so a secret is put with placeholder ciphertexts.
 */
async function publicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
}

async function envelope() {
  return { v: 1, epk: await publicKey(), iv: base64url(new Uint8Array(12)), ct: base64url(new Uint8Array(64)) };
}
const sealed = () => ({ v: 1, iv: base64url(new Uint8Array(12)), ct: base64url(new Uint8Array(48)) });

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let n = 0;
/** A device with a vault key, the owner key if missing, and a collection with one secret at version 1. */
async function setup(): Promise<{ device: TestDevice; collection: string; secret: string }> {
  const device = await createDevice(`pusher-${++n}`);
  const me = await json(await signedJson(device, "PUT", "/api/v1/vault/members/me", { public_key: await publicKey() }));
  let owner = await signedFetch(device, "GET", "/api/v1/vault/owner");
  if (owner.status === 404) owner = await signedJson(device, "PUT", "/api/v1/vault/owner", { public_key: await publicKey(), wraps: [{ wrapped_by: "recovery", envelope: sealed() }] });
  const ownerId = (await json(owner)).member_id;
  const collection = `push-${n}`;
  const created = await signedJson(device, "POST", "/api/v1/vault/collections", {
    name: collection,
    public_key: await publicKey(),
    grants: [{ member_id: me.id, envelope: await envelope() }, { member_id: ownerId, envelope: await envelope() }],
  });
  expect(created.status).toBe(201);
  const put = await signedJson(device, "PUT", `/api/v1/vault/collections/${collection}/secrets/API_KEY`, { version: 1, key_version: 1, wrapped_dek: await envelope(), ciphertext: sealed(), used_by: "Cloud Run" });
  expect(put.status).toBe(201);
  return { device, collection, secret: "API_KEY" };
}

describe("delivery targets", () => {
  it("adds targets in canonical form, refuses bad addresses, and needs plaintext_ok for env files", async () => {
    const { device, collection, secret } = await setup();
    const base = `/api/v1/vault/collections/${collection}/secrets/${secret}/targets`;
    const added = await signedJson(device, "POST", base, { address: " gcp://medishare-492402/medishare-api-key " });
    expect(added.status).toBe(201);
    const target = await json(added);
    expect(target).toMatchObject({ kind: "gcp", address: "gcp://medishare-492402/medishare-api-key", plaintext_ok: false, latest: null, delivered: null });

    const again = await signedJson(device, "POST", base, { address: "gcp://medishare-492402/medishare-api-key" });
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(target.id);

    const bad = await signedJson(device, "POST", base, { address: "s3://bucket/key" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.code).toBe("bad_target");

    const plain = await signedJson(device, "POST", base, { address: "envfile:///home/me/.env#API_KEY" });
    expect(plain.status).toBe(400);
    expect((await json(plain)).error.code).toBe("plaintext_required");
    const accepted = await signedJson(device, "POST", base, { address: "envfile:///home/me/.env#API_KEY", plaintext_ok: true });
    expect(accepted.status).toBe(201);
    expect((await json(accepted)).plaintext_ok).toBe(true);

    const list = await json(await signedFetch(device, "GET", base));
    expect(list.targets.map((t: any) => t.address)).toEqual(["gcp://medishare-492402/medishare-api-key", "envfile:///home/me/.env#API_KEY"]);

    const stranger = await createDevice("stranger");
    await signedJson(stranger, "PUT", "/api/v1/vault/members/me", { public_key: await publicKey() });
    expect((await signedFetch(stranger, "GET", base)).status).toBe(403);
    expect((await signedJson(stranger, "POST", base, { address: "gcp://medishare-492402/other" })).status).toBe(403);
  });

  it("records deliveries, shows them in the status, and keeps records of a removed target", async () => {
    const { device, collection, secret } = await setup();
    const base = `/api/v1/vault/collections/${collection}/secrets/${secret}/targets`;
    const target = await json(await signedJson(device, "POST", base, { address: "github://Keyhole-Koro/MediShare/API_KEY" }));

    const tooNew = await signedJson(device, "POST", `${base}/${target.id}/deliveries`, { version: 2, result: "delivered" });
    expect(tooNew.status).toBe(400);
    const failed = await signedJson(device, "POST", `${base}/${target.id}/deliveries`, { version: 1, result: "failed", note: "gh exited with 1" });
    expect(failed.status).toBe(201);
    let status = await json(await signedFetch(device, "GET", `/api/v1/vault/collections/${collection}/status`));
    expect(status).toMatchObject({ collection, key_version: 1 });
    expect(status.secrets[0]).toMatchObject({ name: secret, current_version: 1, used_by: "Cloud Run" });
    expect(status.secrets[0].targets[0]).toMatchObject({ address: "github://Keyhole-Koro/MediShare/API_KEY", delivered: null });
    expect(status.secrets[0].targets[0].latest).toMatchObject({ version: 1, result: "failed", note: "gh exited with 1" });

    const delivered = await signedJson(device, "POST", `${base}/${target.id}/deliveries`, { version: 1, result: "delivered", remote_ref: "updated 2026-11-19T12:00:00Z", verified: true });
    expect(delivered.status).toBe(201);
    const view = await json(delivered);
    expect(view.delivered).toMatchObject({ version: 1, result: "delivered", remote_ref: "updated 2026-11-19T12:00:00Z" });
    expect(view.delivered.verified_at).toBeTruthy();
    expect(view.latest.id).toBe(view.delivered.id);

    const audit = await env.DB.prepare("select metadata from audit_events where action = 'vault.push' order by event_at desc limit 1").first<{ metadata: string }>();
    expect(audit?.metadata).toContain('"result":"delivered"');
    expect(audit?.metadata).toContain("github://Keyhole-Koro/MediShare/API_KEY");

    const removed = await signedFetch(device, "DELETE", `${base}/${target.id}`);
    expect((await json(removed)).removed).toBe(true);
    status = await json(await signedFetch(device, "GET", `/api/v1/vault/collections/${collection}/status`));
    expect(status.secrets[0].targets).toEqual([]);
    const rows = await env.DB.prepare("select count(*) as c from vault_deliveries where target_id = ?").bind(target.id).first<{ c: number }>();
    expect(rows?.c).toBe(2);
    const readded = await signedJson(device, "POST", base, { address: "github://Keyhole-Koro/MediShare/API_KEY" });
    expect(readded.status).toBe(201);
    expect((await json(readded)).id).not.toBe(target.id);
  });
});
