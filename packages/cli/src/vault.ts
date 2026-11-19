import {
  MAX_VAULT_VALUE_BYTES,
  VAULT_GENERATE_BYTES,
  VAULT_NAME,
  vaultContext,
  type VaultCollectionDetail,
  type VaultCollectionSummary,
  type VaultEnvelope,
  type VaultMember,
  type VaultOwner,
  type VaultRotationPlan,
  type VaultSecretSummary,
  type VaultVersionInfo,
  type VaultVersionResponse,
} from "@artifact/shared";
import { spawn } from "node:child_process";
import { randomBytes, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactError, session, signedJson, type Session } from "./client.ts";
import { loadVaultKeyJson, saveVaultKeyJson, type KeyStore } from "./keystore.ts";
import { loadConfig, saveConfig, writePrivateFile } from "./profile.ts";
import { fingerprint } from "./secret.ts";
import {
  fromUtf8,
  generateKeyPair,
  importPrivateKey,
  newDataKey,
  newRecoverySecret,
  open,
  parsePrivateJwk,
  parseRecoverySecret,
  publicKeyOfJwk,
  recoveryKeyBytes,
  seal,
  unwrapWith,
  utf8,
  wrapTo,
} from "./vault-crypto.ts";

/**
 * The vault, from the device's side (docs/design.md, "金庫"). Values are encrypted and decrypted
 * here; the server only sees wrapped keys and ciphertexts. A value never goes into a return value
 * unless the person asked for it with `--reveal` in a terminal: it goes to a file or into the
 * standard input of an allowed command.
 */

// ---- this device's key ----

interface DeviceKey {
  memberId: string;
  publicKey: string;
  privateKey: webcrypto.CryptoKey;
  store: KeyStore;
}

function checkName(kind: "collection" | "secret", name: string): string {
  const trimmed = name.trim();
  if (!VAULT_NAME.test(trimmed)) throw new ArtifactError(`"${name}" is not a valid ${kind} name: use letters, digits, - _ . (at most 100 characters).`, "bad_name");
  return trimmed;
}

/** Registers this device's encryption key with the server (idempotent) and remembers the member id. */
async function registerKey(s: Session, publicKey: string): Promise<string> {
  const member = await signedJson<VaultMember & { key_changed: boolean }>(s, "PUT", "/api/v1/vault/members/me", { public_key: publicKey });
  const config = loadConfig()!;
  if (config.vault_member_id !== member.id || config.vault_public_key !== publicKey) saveConfig({ ...config, vault_member_id: member.id, vault_public_key: publicKey });
  return member.id;
}

/**
 * This device's vault key: made and registered the first time it is needed. The private key lives
 * in the OS keyring (or a 0600 file when there is none); only the public key goes to the server.
 */
export async function deviceKey(s: Session, { create = true } = {}): Promise<DeviceKey> {
  const stored = await loadVaultKeyJson();
  if (stored) {
    const jwk = parsePrivateJwk(stored.json);
    const publicKey = publicKeyOfJwk(jwk);
    const config = loadConfig();
    const memberId = config?.vault_public_key === publicKey && config.vault_member_id ? config.vault_member_id : await registerKey(s, publicKey);
    return { memberId, publicKey, privateKey: await importPrivateKey(jwk), store: stored.store };
  }
  if (!create) throw new ArtifactError("This device has no vault key yet. Run `artifact vault key` to make one.", "no_key");
  const pair = await generateKeyPair();
  const store = await saveVaultKeyJson(JSON.stringify(pair.privateJwk));
  const memberId = await registerKey(s, pair.publicKey);
  return { memberId, publicKey: pair.publicKey, privateKey: await importPrivateKey(pair.privateJwk), store };
}

export interface DeviceKeyInfo {
  member_id: string;
  fingerprint: string;
  store: KeyStore;
  device_name: string | undefined;
}

/** Makes (if needed) and shows this device's key: the fingerprint is what the owner compares before granting. */
export async function vaultKey(): Promise<DeviceKeyInfo> {
  const s = session();
  const key = await deviceKey(s);
  return { member_id: key.memberId, fingerprint: await fingerprint(key.publicKey), store: key.store, device_name: s.config.device_name };
}

// ---- the owner key and the recovery secret ----

export interface InitResult {
  device: DeviceKeyInfo;
  /** Set only when the owner key was made now: the recovery secret, shown once. */
  recovery_key?: string;
  owner_existed: boolean;
}

/**
 * First-time setup: this device's key, and the owner key wrapped under a new recovery secret.
 * The recovery secret is returned once and never stored; the person keeps it in a password manager
 * or on paper. Without it, losing every device means losing every collection.
 */
export async function vaultInit(): Promise<InitResult> {
  const s = session();
  const key = await deviceKey(s);
  const device = { member_id: key.memberId, fingerprint: await fingerprint(key.publicKey), store: key.store, device_name: s.config.device_name };
  const existing = await ownerOrNull(s);
  if (existing) return { device, owner_existed: true };
  const owner = await generateKeyPair();
  const recovery = newRecoverySecret();
  const envelope = await seal(await recoveryKeyBytes(recovery.bytes), vaultContext.ownerKey("recovery"), utf8(JSON.stringify(owner.privateJwk)));
  await signedJson(s, "PUT", "/api/v1/vault/owner", { public_key: owner.publicKey, wraps: [{ wrapped_by: "recovery", envelope }] });
  return { device, recovery_key: recovery.display, owner_existed: false };
}

async function ownerOrNull(s: Session): Promise<VaultOwner | null> {
  try {
    return await signedJson<VaultOwner>(s, "GET", "/api/v1/vault/owner");
  } catch (e) {
    if (e instanceof ArtifactError && e.code === "no_owner") return null;
    throw e;
  }
}

async function requireOwner(s: Session): Promise<VaultOwner> {
  const owner = await ownerOrNull(s);
  if (!owner) throw new ArtifactError("The vault has no owner key yet. Run `artifact vault init` once (it prints the recovery key).", "no_owner");
  return owner;
}

/** Opens the owner's private key with the recovery secret. */
async function ownerPrivateKey(owner: VaultOwner, recoveryDisplay: string): Promise<webcrypto.CryptoKey> {
  const wrap = owner.wraps.find((w) => w.wrapped_by === "recovery");
  if (!wrap) throw new ArtifactError("The owner key has no recovery wrap.", "no_recovery");
  const keyBytes = await recoveryKeyBytes(parseRecoverySecret(recoveryDisplay));
  let json: string;
  try {
    json = fromUtf8(await open(keyBytes, vaultContext.ownerKey("recovery"), wrap.envelope));
  } catch {
    throw new ArtifactError("The recovery key does not open the owner key. Check the characters (0 and O, 1 and l are the same).", "bad_recovery_key");
  }
  return importPrivateKey(parsePrivateJwk(json));
}

// ---- collections ----

async function collection(s: Session, name: string): Promise<VaultCollectionDetail> {
  return signedJson<VaultCollectionDetail>(s, "GET", `/api/v1/vault/collections/${encodeURIComponent(checkName("collection", name))}`);
}

/** The collection's private key (as the JWK bytes that were wrapped, and imported), opened with this device's grant. */
async function openCollectionKey(key: DeviceKey, detail: VaultCollectionDetail): Promise<{ jwk: Uint8Array; privateKey: webcrypto.CryptoKey }> {
  if (!detail.my_grant) throw new ArtifactError(`This device cannot open "${detail.name}". A device that can must run \`artifact vault grant ${detail.name} ${key.memberId}\`.`, "no_grant");
  const jwk = await unwrapWith(key.privateKey, key.publicKey, vaultContext.collectionKey(detail.name, detail.key_version, key.memberId), detail.my_grant);
  return { jwk, privateKey: await importPrivateKey(parsePrivateJwk(fromUtf8(jwk))) };
}

export async function vaultCreate(name: string): Promise<VaultCollectionDetail> {
  const s = session();
  const cname = checkName("collection", name);
  const key = await deviceKey(s);
  const owner = await requireOwner(s);
  const pair = await generateKeyPair();
  const jwk = utf8(JSON.stringify(pair.privateJwk));
  const grants = [
    { member_id: key.memberId, envelope: await wrapTo(key.publicKey, vaultContext.collectionKey(cname, 1, key.memberId), jwk) },
    { member_id: owner.member_id, envelope: await wrapTo(owner.public_key, vaultContext.collectionKey(cname, 1, owner.member_id), jwk) },
  ];
  return signedJson<VaultCollectionDetail>(s, "POST", "/api/v1/vault/collections", { name: cname, public_key: pair.publicKey, grants });
}

export async function vaultCollections(): Promise<{ member_id: string | null; collections: VaultCollectionSummary[] }> {
  return signedJson(session(), "GET", "/api/v1/vault/collections");
}

export async function vaultSecrets(collectionName: string): Promise<{ collection: string; secrets: VaultSecretSummary[] }> {
  return signedJson(session(), "GET", `/api/v1/vault/collections/${encodeURIComponent(checkName("collection", collectionName))}/secrets`);
}

export interface VaultSecretDetail extends VaultSecretSummary {
  collection: string;
  versions: VaultVersionInfo[];
}

export async function vaultSecret(collectionName: string, secretName: string): Promise<VaultSecretDetail> {
  return signedJson(session(), "GET", `/api/v1/vault/collections/${encodeURIComponent(checkName("collection", collectionName))}/secrets/${encodeURIComponent(checkName("secret", secretName))}`);
}

export interface VaultDeviceInfo extends VaultMember {
  fingerprint: string;
}

/** Members with their fingerprints, computed here from the public keys. */
export async function vaultDevices(): Promise<VaultDeviceInfo[]> {
  const { members } = await signedJson<{ members: VaultMember[] }>(session(), "GET", "/api/v1/vault/members");
  return Promise.all(members.map(async (m) => ({ ...m, fingerprint: await fingerprint(m.public_key) })));
}

// ---- values ----

export type ValueSource = { file: string } | { generate: number } | { value: string };

function readValue(source: ValueSource): Uint8Array {
  let bytes: Uint8Array;
  if ("file" in source) {
    const path = resolve(source.file);
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new ArtifactError(`${path} cannot be read.`, "file_not_found");
    }
    // A trailing newline is almost always the editor's, not the secret's.
    if (bytes.length && bytes[bytes.length - 1] === 10) bytes = bytes.subarray(0, bytes.length - (bytes.length > 1 && bytes[bytes.length - 2] === 13 ? 2 : 1));
  } else if ("generate" in source) {
    const n = source.generate || VAULT_GENERATE_BYTES;
    if (!Number.isInteger(n) || n < 16 || n > 128) throw new ArtifactError("Generate between 16 and 128 random bytes.", "bad_args");
    bytes = utf8(randomBytes(n).toString("base64url"));
  } else {
    bytes = utf8(source.value);
  }
  if (bytes.length === 0) throw new ArtifactError("The value is empty.", "empty");
  if (bytes.length > MAX_VAULT_VALUE_BYTES) throw new ArtifactError(`The value is ${bytes.length} bytes; a vault value is at most ${MAX_VAULT_VALUE_BYTES}.`, "too_large");
  return bytes;
}

export interface PutResult {
  collection: string;
  name: string;
  version: number;
  bytes: number;
  generated: boolean;
}

/**
 * Encrypts a value under a fresh data key, wraps the data key for the collection's current key,
 * and puts it as the next version. Needs no grant: anyone with a device may drop a value in.
 */
export async function vaultPut(collectionName: string, secretName: string, source: ValueSource, ledger: { description?: string; usedBy?: string } = {}): Promise<PutResult> {
  const s = session();
  const cname = checkName("collection", collectionName);
  const sname = checkName("secret", secretName);
  const bytes = readValue(source);
  for (let attempt = 0; attempt < 3; attempt++) {
    const detail = await collection(s, cname);
    const current = await currentVersion(s, cname, sname);
    const version = current + 1;
    const dek = newDataKey();
    const ciphertext = await seal(dek, vaultContext.value(cname, sname, version), bytes);
    const wrappedDek = await wrapTo(detail.public_key, vaultContext.dataKey(cname, sname, version), dek);
    try {
      const r = await signedJson<{ version: number }>(s, "PUT", `/api/v1/vault/collections/${encodeURIComponent(cname)}/secrets/${encodeURIComponent(sname)}`, {
        ...(ledger.description !== undefined ? { description: ledger.description } : {}),
        ...(ledger.usedBy !== undefined ? { used_by: ledger.usedBy } : {}),
        version,
        key_version: detail.key_version,
        wrapped_dek: wrappedDek,
        ciphertext,
      });
      return { collection: cname, name: sname, version: r.version, bytes: bytes.length, generated: "generate" in source };
    } catch (e) {
      // Someone put a version or rotated the key in between: encrypt again for the new state.
      if (e instanceof ArtifactError && (e.code === "version_conflict" || e.code === "key_rotated") && attempt < 2) continue;
      throw e;
    }
  }
  throw new ArtifactError("The secret kept changing while putting it. Try again.", "conflict");
}

async function currentVersion(s: Session, cname: string, sname: string): Promise<number> {
  try {
    const detail = await signedJson<VaultSecretDetail>(s, "GET", `/api/v1/vault/collections/${encodeURIComponent(cname)}/secrets/${encodeURIComponent(sname)}`);
    return detail.current_version;
  } catch (e) {
    if (e instanceof ArtifactError && e.code === "not_found") return 0;
    // Putting needs no grant; reading the version does. Without one, start from the server's answer.
    if (e instanceof ArtifactError && e.code === "no_grant") return 0;
    throw e;
  }
}

/** Where a value goes. Only a person at a terminal gets `reveal`. */
export type ValueSink = { file: string } | { command: string[] } | { reveal: true };

/** Commands a value may be piped into. The value goes to their standard input, never to an argument. */
export const ALLOWED_COMMANDS = ["gcloud", "gh", "wrangler", "circleci"] as const;

export interface UseResult {
  collection: string;
  name: string;
  version: number;
  bytes: number;
  /** Where it went: the file path, the command, or the value itself for `reveal`. */
  delivered: { file: string } | { command: string; exit_code: number; stdout: string; stderr: string } | { value: string };
}

/** Opens a version (the latest unless given) with this device's key and delivers it without showing it. */
export async function vaultUse(collectionName: string, secretName: string, sink: ValueSink, version?: number): Promise<UseResult> {
  const s = session();
  const cname = checkName("collection", collectionName);
  const sname = checkName("secret", secretName);
  if ("command" in sink) {
    const bin = sink.command[0];
    if (!bin || !(ALLOWED_COMMANDS as readonly string[]).includes(bin)) {
      throw new ArtifactError(`A value can be piped only into ${ALLOWED_COMMANDS.join(", ")} (got "${bin ?? ""}"). Write it to a 0600 file instead, or extend the allow list.`, "bad_command");
    }
  }
  const key = await deviceKey(s, { create: false });
  const r = await signedJson<VaultVersionResponse>(s, "GET", `/api/v1/vault/collections/${encodeURIComponent(cname)}/secrets/${encodeURIComponent(sname)}/versions/${version ?? "latest"}`);
  const collectionKey = await importPrivateKey(parsePrivateJwk(fromUtf8(await unwrapWith(key.privateKey, key.publicKey, vaultContext.collectionKey(cname, r.key_version, key.memberId), r.grant))));
  const dek = await unwrapWith(collectionKey, r.collection_public_key, vaultContext.dataKey(cname, sname, r.version), r.wrapped_dek);
  const value = await open(dek, vaultContext.value(cname, sname, r.version), r.ciphertext);
  const base = { collection: cname, name: sname, version: r.version, bytes: value.length };
  if ("file" in sink) {
    const path = resolve(sink.file);
    writePrivateFile(path, fromUtf8(value));
    return { ...base, delivered: { file: path } };
  }
  if ("command" in sink) {
    const result = await pipeInto(sink.command, value);
    if (result.exit_code !== 0) throw new ArtifactError(`${sink.command.join(" ")} exited with ${result.exit_code}: ${result.stderr.trim().slice(0, 500)}`, "command_failed", { ...result });
    return { ...base, delivered: { command: sink.command.join(" "), ...result } };
  }
  return { ...base, delivered: { value: fromUtf8(value) } };
}

function pipeInto(command: string[], value: Uint8Array): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const [bin, ...args] = command as [string, ...string[]];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => reject(new ArtifactError(`Could not run ${bin}: ${e.message}`, "command_failed")));
    child.on("close", (code) => resolvePromise({ exit_code: code ?? -1, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(value));
  });
}

export async function vaultLedger(collectionName: string, secretName: string, patch: { description?: string | null; usedBy?: string | null }): Promise<VaultSecretSummary> {
  const body: Record<string, unknown> = {};
  if (patch.description !== undefined) body["description"] = patch.description;
  if (patch.usedBy !== undefined) body["used_by"] = patch.usedBy;
  return signedJson(session(), "PATCH", `/api/v1/vault/collections/${encodeURIComponent(checkName("collection", collectionName))}/secrets/${encodeURIComponent(checkName("secret", secretName))}`, body);
}

export async function vaultDestroy(collectionName: string, secretName: string, version?: number): Promise<{ destroyed?: boolean; deleted?: boolean; version?: number }> {
  const s = session();
  const path = `/api/v1/vault/collections/${encodeURIComponent(checkName("collection", collectionName))}/secrets/${encodeURIComponent(checkName("secret", secretName))}`;
  if (version === undefined) return signedJson(s, "DELETE", path);
  if (!Number.isInteger(version) || version < 1) throw new ArtifactError("The version is a number from 1.", "bad_args");
  return signedJson(s, "DELETE", `${path}/versions/${version}`);
}

// ---- who can read ----

async function findMember(s: Session, who: string): Promise<VaultMember> {
  const { members } = await signedJson<{ members: VaultMember[] }>(s, "GET", "/api/v1/vault/members");
  const live = members.filter((m) => m.revoked_at === null && m.kind === "device");
  const hits = live.filter((m) => m.id === who || m.device_id === who || m.device_name === who);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new ArtifactError(`"${who}" matches ${hits.length} devices. Use the member id: ${hits.map((m) => `${m.id} (${m.device_name ?? m.device_id})`).join(", ")}.`, "ambiguous");
  throw new ArtifactError(`No device with a vault key is named "${who}". \`artifact vault devices\` lists them; the device itself runs \`artifact vault key\` first.`, "unknown_member");
}

export interface GrantResult {
  collection: string;
  member: VaultDeviceInfo;
}

/** Wraps the collection key for another device. Compare the fingerprint with `artifact vault key` on that device first. */
export async function vaultGrant(collectionName: string, who: string): Promise<GrantResult> {
  const s = session();
  const key = await deviceKey(s, { create: false });
  const detail = await collection(s, collectionName);
  const target = await findMember(s, who);
  const { jwk } = await openCollectionKey(key, detail);
  const envelope = await wrapTo(target.public_key, vaultContext.collectionKey(detail.name, detail.key_version, target.id), jwk);
  await signedJson(s, "POST", `/api/v1/vault/collections/${encodeURIComponent(detail.name)}/grants`, { member_id: target.id, key_version: detail.key_version, envelope });
  return { collection: detail.name, member: { ...target, fingerprint: await fingerprint(target.public_key) } };
}

export interface RotateResult {
  collection: string;
  key_version: number;
  members: number;
  versions: number;
}

/** Replaces the collection key, re-wrapping it for the remaining members and every live version's data key. */
export async function vaultRotate(collectionName: string): Promise<RotateResult> {
  const s = session();
  const key = await deviceKey(s, { create: false });
  const cname = checkName("collection", collectionName);
  const detail = await collection(s, cname);
  const plan = await signedJson<VaultRotationPlan>(s, "GET", `/api/v1/vault/collections/${encodeURIComponent(cname)}/rotation`);
  const { privateKey: oldPrivate } = await openCollectionKey(key, detail);
  const next = await generateKeyPair();
  const nextVersion = plan.key_version + 1;
  const jwk = utf8(JSON.stringify(next.privateJwk));
  const owner = await requireOwner(s);
  const memberIds = new Set([...plan.members.map((m) => m.id), key.memberId, owner.member_id]);
  const grants = [];
  for (const id of memberIds) {
    const member = id === owner.member_id ? { id: owner.member_id, public_key: owner.public_key } : id === key.memberId ? { id: key.memberId, public_key: key.publicKey } : plan.members.find((m) => m.id === id)!;
    grants.push({ member_id: id, envelope: await wrapTo(member.public_key, vaultContext.collectionKey(cname, nextVersion, id), jwk) });
  }
  const versions = [];
  for (const v of plan.versions) {
    const dek = await unwrapWith(oldPrivate, plan.public_key, vaultContext.dataKey(cname, v.secret, v.version), v.wrapped_dek);
    versions.push({ secret: v.secret, version: v.version, wrapped_dek: await wrapTo(next.publicKey, vaultContext.dataKey(cname, v.secret, v.version), dek) });
  }
  const r = await signedJson<VaultCollectionDetail>(s, "POST", `/api/v1/vault/collections/${encodeURIComponent(cname)}/rotate`, { key_version: nextVersion, public_key: next.publicKey, grants, versions });
  return { collection: cname, key_version: r.key_version, members: grants.length, versions: versions.length };
}

export interface RevokeResult extends RotateResult {
  removed: boolean;
  member: string;
}

/** Takes a device's grant away and rotates the key, since that device may have copied the old one. */
export async function vaultRevoke(collectionName: string, who: string): Promise<RevokeResult> {
  const s = session();
  const cname = checkName("collection", collectionName);
  const target = await findMember(s, who);
  const { removed } = await signedJson<{ removed: boolean }>(s, "DELETE", `/api/v1/vault/collections/${encodeURIComponent(cname)}/grants/${encodeURIComponent(target.id)}`);
  const rotated = await vaultRotate(cname);
  return { ...rotated, removed, member: target.id };
}

export interface RecoverResult {
  device: DeviceKeyInfo;
  collections: string[];
}

/**
 * With the recovery key, opens the owner key and gives this device a grant on every collection.
 * For when every device that could read was lost or replaced.
 */
export async function vaultRecover(recoveryDisplay: string): Promise<RecoverResult> {
  const s = session();
  const key = await deviceKey(s);
  const owner = await requireOwner(s);
  const ownerKey = await ownerPrivateKey(owner, recoveryDisplay);
  const { collections } = await vaultCollections();
  const granted: string[] = [];
  for (const c of collections) {
    if (c.readable) continue;
    const detail = await collection(s, c.name);
    const ownerGrant = await signedJson<{ grant: VaultEnvelope | null }>(s, "GET", `/api/v1/vault/collections/${encodeURIComponent(c.name)}/owner-grant`);
    if (!ownerGrant.grant) continue;
    const jwk = await unwrapWith(ownerKey, owner.public_key, vaultContext.collectionKey(c.name, detail.key_version, owner.member_id), ownerGrant.grant);
    const envelope = await wrapTo(key.publicKey, vaultContext.collectionKey(c.name, detail.key_version, key.memberId), jwk);
    await signedJson(s, "POST", `/api/v1/vault/collections/${encodeURIComponent(c.name)}/grants`, { member_id: key.memberId, key_version: detail.key_version, envelope });
    granted.push(c.name);
  }
  return { device: { member_id: key.memberId, fingerprint: await fingerprint(key.publicKey), store: key.store, device_name: s.config.device_name }, collections: granted };
}
