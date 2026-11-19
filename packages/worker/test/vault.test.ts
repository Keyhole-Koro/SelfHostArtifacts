import { vaultContext } from "@artifact/shared";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64url, fromBase64url, utf8 } from "../src/lib/encoding.ts";
import { ORIGIN, browserPost, createDevice, sessionCookie, signedFetch, signedJson, type TestDevice } from "./helpers.ts";

/**
 * The device's side of the vault, as the CLI does it (packages/cli/src/vault-crypto.ts), in Web
 * Crypto: P-256 key pairs, envelope v1 for a public key, AES-GCM under a data key.
 */
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

interface KeyPair {
  publicKey: string;
  privateKey: CryptoKey;
  jwk: string;
}

async function keyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: base64url(raw), privateKey: pair.privateKey, jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)) };
}

async function importJwk(jwk: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", JSON.parse(jwk), P256, true, ["deriveBits"]);
}

async function hkdf(bits: ArrayBuffer, salt: Uint8Array, context: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8(context) }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}

async function wrapTo(publicKey: string, context: string, plaintext: Uint8Array) {
  const rpk = fromBase64url(publicKey);
  const recipient = await crypto.subtle.importKey("raw", rpk, P256, false, []);
  const sender = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm, sender.privateKey, 256);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const key = await hkdf(bits, salt, context, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(context) }, key, plaintext));
  return { v: 1 as const, epk: base64url(epk), iv: base64url(iv), ct: base64url(ct) };
}

async function unwrapWith(privateKey: CryptoKey, publicKey: string, context: string, envelope: { epk: string; iv: string; ct: string }): Promise<Uint8Array> {
  const epk = fromBase64url(envelope.epk);
  const rpk = fromBase64url(publicKey);
  const sender = await crypto.subtle.importKey("raw", epk, P256, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: sender } as unknown as SubtleCryptoDeriveKeyAlgorithm, privateKey, 256);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const key = await hkdf(bits, salt, context, "decrypt");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(envelope.iv), additionalData: utf8(context) }, key, fromBase64url(envelope.ct)));
}

async function seal(dek: Uint8Array<ArrayBuffer>, context: string, plaintext: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(context) }, key, plaintext));
  return { v: 1 as const, iv: base64url(iv), ct: base64url(ct) };
}

async function open(dek: Uint8Array<ArrayBuffer>, context: string, sealed: { iv: string; ct: string }): Promise<string> {
  const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["decrypt"]);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv), additionalData: utf8(context) }, key, fromBase64url(sealed.ct)));
}

// ---- a device with a vault key, as `artifact vault key` leaves it ----

interface Member {
  device: TestDevice;
  key: KeyPair;
  memberId: string;
}

async function member(name = "laptop"): Promise<Member> {
  const device = await createDevice(name);
  const key = await keyPair();
  const res = await signedJson(device, "PUT", "/api/v1/vault/members/me", { public_key: key.publicKey });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return { device, key, memberId: body.id };
}

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * `artifact vault init`: the owner key, wrapped under a recovery secret (here any AES key). The
 * vault has one owner key, and the database lives through the whole file, so later tests reuse it.
 */
async function owner(by: TestDevice): Promise<{ key: { publicKey: string }; memberId: string }> {
  const existing = await signedFetch(by, "GET", "/api/v1/vault/owner");
  if (existing.status === 200) {
    const view = await json(existing);
    return { key: { publicKey: view.public_key }, memberId: view.member_id };
  }
  const key = await keyPair();
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const envelope = await seal(dek, vaultContext.ownerKey("recovery"), utf8(key.jwk));
  const res = await signedJson(by, "PUT", "/api/v1/vault/owner", { public_key: key.publicKey, wraps: [{ wrapped_by: "recovery", envelope }] });
  expect(res.status).toBe(201);
  return { key, memberId: (await json(res)).member_id };
}

/** `artifact vault create`: a collection key wrapped for the creating device and the owner. */
async function createCollection(m: Member, ownerKey: { key: { publicKey: string }; memberId: string }, name: string) {
  const key = await keyPair();
  const grants = [
    { member_id: m.memberId, envelope: await wrapTo(m.key.publicKey, vaultContext.collectionKey(name, 1, m.memberId), utf8(key.jwk)) },
    { member_id: ownerKey.memberId, envelope: await wrapTo(ownerKey.key.publicKey, vaultContext.collectionKey(name, 1, ownerKey.memberId), utf8(key.jwk)) },
  ];
  const res = await signedJson(m.device, "POST", "/api/v1/vault/collections", { name, public_key: key.publicKey, grants });
  expect(res.status).toBe(201);
  return { key, detail: await json(res) };
}

/** `artifact vault put`: a fresh data key wraps the value; the collection's public key wraps the data key. */
async function put(by: TestDevice, collection: { name: string; public_key: string; key_version: number }, name: string, version: number, value: string, extra: object = {}) {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await seal(dek, vaultContext.value(collection.name, name, version), utf8(value));
  const wrapped_dek = await wrapTo(collection.public_key, vaultContext.dataKey(collection.name, name, version), dek);
  return signedJson(by, "PUT", `/api/v1/vault/collections/${collection.name}/secrets/${name}`, { version, key_version: collection.key_version, wrapped_dek, ciphertext, ...extra });
}

/** `artifact vault use`: grant → collection key → data key → value. */
async function read(m: Member, collection: string, name: string, version: number | "latest" = "latest"): Promise<{ status: number; value?: string; body: any }> {
  const res = await signedFetch(m.device, "GET", `/api/v1/vault/collections/${collection}/secrets/${name}/versions/${version}`);
  const body = await json(res);
  if (res.status !== 200) return { status: res.status, body };
  const jwk = await unwrapWith(m.key.privateKey, m.key.publicKey, vaultContext.collectionKey(collection, body.key_version, m.memberId), body.grant);
  const collectionKey = await importJwk(new TextDecoder().decode(jwk));
  const dek = (await unwrapWith(collectionKey, body.collection_public_key, vaultContext.dataKey(collection, name, body.version), body.wrapped_dek)) as Uint8Array<ArrayBuffer>;
  return { status: 200, value: await open(dek, vaultContext.value(collection, name, body.version), body.ciphertext), body };
}

let n = 0;
const unique = (base: string) => `${base}-${++n}`;

describe("vault keys", () => {
  it("registers a device key once, and a replaced key drops the device's grants", async () => {
    const m = await member();
    const again = await signedJson(m.device, "PUT", "/api/v1/vault/members/me", { public_key: m.key.publicKey });
    expect(again.status).toBe(200);
    expect((await json(again)).key_changed).toBe(false);
    const o = await owner(m.device);
    const name = unique("proj");
    await createCollection(m, o, name);
    const replaced = await signedJson(m.device, "PUT", "/api/v1/vault/members/me", { public_key: (await keyPair()).publicKey });
    expect(replaced.status).toBe(200);
    expect((await json(replaced)).key_changed).toBe(true);
    const detail = await json(await signedFetch(m.device, "GET", `/api/v1/vault/collections/${name}`));
    expect(detail.readable).toBe(false);
    expect(detail.my_grant).toBeNull();
  });

  it("keeps one owner key; new wraps must be for that key, and a device without a key is told so", async () => {
    const m = await member();
    const o = await owner(m.device);
    const other = await keyPair();
    const res = await signedJson(m.device, "PUT", "/api/v1/vault/owner", { public_key: other.publicKey, wraps: [{ wrapped_by: "recovery", envelope: await seal(crypto.getRandomValues(new Uint8Array(32)), "x", utf8("y")) }] });
    expect(res.status).toBe(409);
    const view = await json(await signedFetch(m.device, "GET", "/api/v1/vault/owner"));
    expect(view.member_id).toBe(o.memberId);
    expect(view.wraps.map((w: any) => w.wrapped_by)).toEqual(["recovery"]);

    const keyless = await createDevice("no-key");
    const create = await signedJson(keyless, "POST", "/api/v1/vault/collections", { name: unique("x"), public_key: other.publicKey, grants: [{ member_id: "nobody", envelope: await wrapTo(other.publicKey, "c", utf8("k")) }] });
    expect(create.status).toBe(403);
    expect((await json(create)).error.code).toBe("no_key");
  });
});

describe("vault collections and values", () => {
  it("creates a collection only with a grant for the owner, and lists who can read it", async () => {
    const m = await member();
    const o = await owner(m.device);
    const name = unique("medishare-stg");
    const key = await keyPair();
    const noOwner = await signedJson(m.device, "POST", "/api/v1/vault/collections", {
      name,
      public_key: key.publicKey,
      grants: [{ member_id: m.memberId, envelope: await wrapTo(m.key.publicKey, vaultContext.collectionKey(name, 1, m.memberId), utf8(key.jwk)) }],
    });
    expect(noOwner.status).toBe(400);
    expect((await json(noOwner)).error.code).toBe("owner_required");

    const { detail } = await createCollection(m, o, name);
    expect(detail).toMatchObject({ name, key_version: 1, members: 2, secrets: 0, readable: true });
    expect(detail.grants.map((g: any) => g.kind).sort()).toEqual(["device", "owner"]);

    const stranger = await member("other");
    const list = await json(await signedFetch(stranger.device, "GET", "/api/v1/vault/collections"));
    expect(list.collections.find((c: any) => c.name === name)).toMatchObject({ readable: false, members: 2 });
    const dup = await signedJson(m.device, "POST", "/api/v1/vault/collections", { name, public_key: key.publicKey, grants: detail.grants.map((g: any) => ({ member_id: g.id, envelope: { v: 1, epk: key.publicKey, iv: base64url(new Uint8Array(12)), ct: base64url(new Uint8Array(32)) } })) });
    expect(dup.status).toBe(409);
  });

  it("stores a value as the next version and only the device's key opens it; the database never holds the plaintext", async () => {
    const m = await member();
    const o = await owner(m.device);
    const name = unique("proj");
    const { detail } = await createCollection(m, o, name);
    const value = "sk_live_0123456789abcdef";
    const first = await put(m.device, detail, "PAYJP_SECRET_KEY", 1, value, { description: "PAY.JP の秘密鍵", used_by: "Cloud Run medishare-web" });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({ collection: name, name: "PAYJP_SECRET_KEY", version: 1 });

    const opened = await read(m, name, "PAYJP_SECRET_KEY");
    expect(opened.status).toBe(200);
    expect(opened.value).toBe(value);

    const rows = await env.DB.prepare("select * from vault_versions").all();
    expect(JSON.stringify(rows.results)).not.toContain(value);
    const secrets = await json(await signedFetch(m.device, "GET", `/api/v1/vault/collections/${name}/secrets`));
    expect(secrets.secrets).toEqual([expect.objectContaining({ name: "PAYJP_SECRET_KEY", description: "PAY.JP の秘密鍵", used_by: "Cloud Run medishare-web", current_version: 1, live_versions: 1 })]);

    // The next put must name version 2; a stale version number is refused, and so is a stale key version.
    const stale = await put(m.device, detail, "PAYJP_SECRET_KEY", 1, "again");
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe("version_conflict");
    const wrongKey = await put(m.device, { ...detail, key_version: 7 }, "PAYJP_SECRET_KEY", 2, "again");
    expect(wrongKey.status).toBe(409);
    expect((await json(wrongKey)).error.code).toBe("key_rotated");
    const second = await put(m.device, detail, "PAYJP_SECRET_KEY", 2, "sk_live_new");
    expect(second.status).toBe(201);
    expect((await read(m, name, "PAYJP_SECRET_KEY")).value).toBe("sk_live_new");
    expect((await read(m, name, "PAYJP_SECRET_KEY", 1)).value).toBe(value);

    const audit = await env.DB.prepare("select action, metadata from audit_events where action = 'vault.read' order by event_at desc limit 1").first<{ action: string; metadata: string }>();
    expect(audit?.metadata).toContain("PAYJP_SECRET_KEY");
    expect(audit?.metadata).not.toContain(value);
  });

  it("lets any device drop a value in, but only members read, list or grant", async () => {
    const m = await member();
    const o = await owner(m.device);
    const name = unique("proj");
    const { detail } = await createCollection(m, o, name);
    const stranger = await member("ci-runner");
    expect((await put(stranger.device, detail, "DROPPED", 1, "from ci")).status).toBe(201);
    expect((await read(m, name, "DROPPED")).value).toBe("from ci");

    const list = await signedFetch(stranger.device, "GET", `/api/v1/vault/collections/${name}/secrets`);
    expect(list.status).toBe(403);
    expect((await json(list)).error.code).toBe("no_grant");
    expect((await read(stranger, name, "DROPPED")).status).toBe(403);

    // Granting a third device needs a grant of one's own; a device may always add a grant for itself (recovery does that).
    const third = await member("desk");
    const bogus = { v: 1, epk: third.key.publicKey, iv: base64url(new Uint8Array(12)), ct: base64url(new Uint8Array(40)) };
    const forThird = await signedJson(stranger.device, "POST", `/api/v1/vault/collections/${name}/grants`, { member_id: third.memberId, key_version: 1, envelope: bogus });
    expect(forThird.status).toBe(403);
    const forSelf = await signedJson(stranger.device, "POST", `/api/v1/vault/collections/${name}/grants`, { member_id: stranger.memberId, key_version: 1, envelope: bogus });
    expect(forSelf.status).toBe(201);
    // A bogus self-grant opens nothing: reading still fails at the device, not at the server.
    const res = await signedFetch(stranger.device, "GET", `/api/v1/vault/collections/${name}/secrets/DROPPED/versions/latest`);
    expect(res.status).toBe(200);
    await expect(read(stranger, name, "DROPPED")).rejects.toThrow();
  });

  it("grants another device, revokes it with a rotation plan, and after rotating only the new key works", async () => {
    const m = await member("laptop");
    const o = await owner(m.device);
    const name = unique("proj");
    const { key, detail } = await createCollection(m, o, name);
    await put(m.device, detail, "A", 1, "a1");
    await put(m.device, detail, "A", 2, "a2");
    await put(m.device, detail, "B", 1, "b1");
    expect((await signedFetch(m.device, "DELETE", `/api/v1/vault/collections/${name}/secrets/B/versions/1`)).status).toBe(200);

    const phone = await member("phone");
    const grant = await signedJson(m.device, "POST", `/api/v1/vault/collections/${name}/grants`, {
      member_id: phone.memberId,
      key_version: 1,
      envelope: await wrapTo(phone.key.publicKey, vaultContext.collectionKey(name, 1, phone.memberId), utf8(key.jwk)),
    });
    expect(grant.status).toBe(201);
    expect((await read(phone, name, "A")).value).toBe("a2");

    const ownerGrant = await signedFetch(m.device, "DELETE", `/api/v1/vault/collections/${name}/grants/${o.memberId}`);
    expect(ownerGrant.status).toBe(400);
    const revoke = await signedFetch(m.device, "DELETE", `/api/v1/vault/collections/${name}/grants/${phone.memberId}`);
    expect(revoke.status).toBe(200);
    const { removed, rotation } = await json(revoke);
    expect(removed).toBe(true);
    expect(rotation.members.map((x: any) => x.id).sort()).toEqual([m.memberId, o.memberId].sort());
    // Only live versions are in the plan: A@1, A@2 (B@1 was destroyed).
    expect(rotation.versions.map((v: any) => `${v.secret}@${v.version}`)).toEqual(["A@1", "A@2"]);
    expect((await read(phone, name, "A")).status).toBe(403);

    // Rotate: a new collection key for the remaining members, every live data key re-wrapped.
    const next = await keyPair();
    const oldKey = await importJwk(key.jwk);
    const grants = [];
    for (const mem of rotation.members) grants.push({ member_id: mem.id, envelope: await wrapTo(mem.public_key, vaultContext.collectionKey(name, 2, mem.id), utf8(next.jwk)) });
    const versions = [];
    for (const v of rotation.versions) {
      const dek = await unwrapWith(oldKey, rotation.public_key, vaultContext.dataKey(name, v.secret, v.version), v.wrapped_dek);
      versions.push({ secret: v.secret, version: v.version, wrapped_dek: await wrapTo(next.publicKey, vaultContext.dataKey(name, v.secret, v.version), dek) });
    }
    const incomplete = await signedJson(m.device, "POST", `/api/v1/vault/collections/${name}/rotate`, { key_version: 2, public_key: next.publicKey, grants, versions: versions.slice(1) });
    expect(incomplete.status).toBe(409);
    expect((await json(incomplete)).error.code).toBe("versions_missing");
    const rotated = await signedJson(m.device, "POST", `/api/v1/vault/collections/${name}/rotate`, { key_version: 2, public_key: next.publicKey, grants, versions });
    expect(rotated.status).toBe(200);
    expect((await json(rotated)).key_version).toBe(2);

    expect((await read(m, name, "A")).value).toBe("a2");
    expect((await read(m, name, "A", 1)).value).toBe("a1");
    const staleKey = await put(m.device, detail, "A", 3, "a3");
    expect(staleKey.status).toBe(409);
    expect((await json(staleKey)).error.code).toBe("key_rotated");
    const fresh = await json(await signedFetch(m.device, "GET", `/api/v1/vault/collections/${name}`));
    expect((await put(m.device, fresh, "A", 3, "a3")).status).toBe(201);
    expect((await read(m, name, "A")).value).toBe("a3");
    const ownerGrantAfter = await json(await signedFetch(phone.device, "GET", `/api/v1/vault/collections/${name}/owner-grant`));
    expect(ownerGrantAfter.key_version).toBe(2);
    expect(ownerGrantAfter.grant).toBeTruthy();
  });

  it("destroys a version for good and deletes a whole secret", async () => {
    const m = await member();
    const o = await owner(m.device);
    const name = unique("proj");
    const { detail } = await createCollection(m, o, name);
    await put(m.device, detail, "K", 1, "k1");
    await put(m.device, detail, "K", 2, "k2");
    expect((await signedFetch(m.device, "DELETE", `/api/v1/vault/collections/${name}/secrets/K/versions/1`)).status).toBe(200);
    expect((await read(m, name, "K", 1)).status).toBe(410);
    expect((await read(m, name, "K")).value).toBe("k2");
    const row = await env.DB.prepare(
      `select v.ciphertext, v.wrapped_dek, v.destroyed_at from vault_versions v
       join vault_secrets s on s.id = v.secret_id join vault_collections c on c.id = s.collection_id
       where c.name = ? and s.name = 'K' and v.version = 1`,
    ).bind(name).first<{ ciphertext: string; wrapped_dek: string; destroyed_at: string }>();
    expect(row).toMatchObject({ ciphertext: "", wrapped_dek: "" });
    expect(row?.destroyed_at).toBeTruthy();
    const shown = await json(await signedFetch(m.device, "GET", `/api/v1/vault/collections/${name}/secrets/K`));
    expect(shown.live_versions).toBe(1);
    expect(shown.versions.map((v: any) => [v.version, Boolean(v.destroyed_at)])).toEqual([[2, false], [1, true]]);
    expect((await signedFetch(m.device, "DELETE", `/api/v1/vault/collections/${name}/secrets/K`)).status).toBe(200);
    expect((await read(m, name, "K")).status).toBe(404);
  });

  it("revoking the device in Settings revokes its vault key too", async () => {
    const m = await member("stolen");
    const o = await owner(m.device);
    const name = unique("proj");
    await createCollection(m, o, name);
    const { cookie, csrf } = await sessionCookie("root");
    const res = await browserPost(`/settings/devices/${m.device.id}/revoke`, cookie, { csrf });
    expect([302, 303]).toContain(res.status);
    const row = await env.DB.prepare("select revoked_at from vault_members where id = ?").bind(m.memberId).first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBeTruthy();
    const members = await json(await signedFetch((await member("new")).device, "GET", "/api/v1/vault/members"));
    expect(members.members.find((x: any) => x.id === m.memberId).revoked_at).toBeTruthy();
    expect(ORIGIN).toBeTruthy();
  });
});
