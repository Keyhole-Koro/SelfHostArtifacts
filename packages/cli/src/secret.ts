import {
  MAX_SECRET_ITEMS,
  MAX_SECRET_NAME,
  MAX_SECRET_PLAINTEXT_BYTES,
  MAX_SECRET_VALUE,
  SECRET_INFO,
  SECRET_SHARE_INFO,
  type SecretEnvelope,
  type SecretShareEnvelope,
  type SecretItem,
  type SecretPlaintext,
} from "@artifact/shared";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { ArtifactError } from "./client.ts";

/**
 * The sender's side of a secret handoff. Values are read from a local file and encrypted here, so
 * they never pass through the agent's conversation or the server in plain text. Error messages may
 * name keys but never include a value.
 */

const subtle = webcrypto.subtle;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** 12 digits from SHA-256 of the raw public key, the same as the recipient's page shows. */
export async function fingerprint(publicKey: string): Promise<string> {
  const d = new Uint8Array(await subtle.digest("SHA-256", Buffer.from(publicKey, "base64url")));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(d[i]!);
  const s = (n % 1_000_000_000_000n).toString().padStart(12, "0");
  return `${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8)}`;
}

function encodePlaintext(plaintext: SecretPlaintext): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(plaintext));
  if (data.length > MAX_SECRET_PLAINTEXT_BYTES) {
    throw new ArtifactError(`The secret is ${data.length} bytes; at most ${MAX_SECRET_PLAINTEXT_BYTES} can be sent.`, "too_large");
  }
  return data;
}

/** Envelope v1 (see @artifact/shared secret.ts): one-time ECDH P-256 → HKDF-SHA256 → AES-256-GCM. */
export async function encryptForRecipient(id: string, recipientPublicKey: string, plaintext: SecretPlaintext): Promise<SecretEnvelope> {
  const data = encodePlaintext(plaintext);
  const rpk = new Uint8Array(Buffer.from(recipientPublicKey, "base64url"));
  const recipient = await subtle.importKey("raw", rpk, P256, false, []);
  const sender = (await subtle.generateKey(P256, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const epk = new Uint8Array(await subtle.exportKey("raw", sender.publicKey));
  const bits = await subtle.deriveBits({ name: "ECDH", public: recipient }, sender.privateKey, 256);
  const ikm = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const context = new TextEncoder().encode(`${SECRET_INFO}\0${id}`);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, data));
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/**
 * Share mode (see @artifact/shared secret.ts): a fresh 32-byte link secret → HKDF-SHA256 → AES-256-GCM.
 * The link secret goes after the # of the recipient's link and never to the server.
 */
export async function encryptForLink(plaintext: SecretPlaintext): Promise<{ linkSecret: string; envelope: SecretShareEnvelope }> {
  const data = encodePlaintext(plaintext);
  const secret = webcrypto.getRandomValues(new Uint8Array(32));
  const info = new TextEncoder().encode(SECRET_SHARE_INFO);
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: info }, key, data));
  return { linkSecret: b64(secret), envelope: { v: 1, iv: b64(iv), ct: b64(ct) } };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, "");
}

/** KEY=VALUE lines; blank lines, comments and `export ` are ignored. */
export function parseEnv(text: string): SecretItem[] {
  const items: SecretItem[] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(trimmed);
    if (!m) throw new ArtifactError(`Line ${i + 1} is not KEY=VALUE.`, "bad_secret_file");
    items.push({ name: m[1]!, value: unquote(m[2]!) });
  }
  return items;
}

/** { "NAME": "value" } or { "items": [{ "name": …, "value": … }] }. */
export function parseJson(text: string): SecretItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ArtifactError("The file is not valid JSON.", "bad_secret_file");
  }
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    return ((data as { items: unknown[] }).items).map((item, i) => {
      const { name, value } = (item ?? {}) as { name?: unknown; value?: unknown };
      if (typeof name !== "string" || typeof value !== "string") throw new ArtifactError(`items[${i}] needs a string name and value.`, "bad_secret_file");
      return { name, value };
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ArtifactError('Use { "NAME": "value", … } or { "items": [{ "name": …, "value": … }] }.', "bad_secret_file");
  }
  return Object.entries(data as Record<string, unknown>).map(([name, value]) => {
    if (typeof value !== "string" && typeof value !== "number") throw new ArtifactError(`${name} is not a string.`, "bad_secret_file");
    return { name, value: String(value) };
  });
}

/**
 * Which items to send, and the name to show for each: an array keeps the names, an object
 * renames ({ "SMTP_PASSWORD": "notify@example.com" }). Undefined sends everything.
 */
export type KeySelection = string[] | Record<string, string>;

export function selectItems(items: SecretItem[], keys?: KeySelection): SecretItem[] {
  if (!keys || (Array.isArray(keys) ? keys.length === 0 : Object.keys(keys).length === 0)) return items;
  const pairs: [string, string][] = Array.isArray(keys) ? keys.map((k) => [k, k]) : Object.entries(keys);
  const byName = new Map(items.map((i) => [i.name, i.value]));
  const missing = pairs.map(([k]) => k).filter((k) => !byName.has(k));
  if (missing.length) {
    throw new ArtifactError(`The file has no ${missing.join(", ")}. It has: ${[...byName.keys()].join(", ") || "(nothing)"}.`, "missing_key");
  }
  return pairs.map(([k, label]) => ({ name: label, value: byName.get(k)! }));
}

export function validateItems(items: SecretItem[]): void {
  if (items.length === 0) throw new ArtifactError("There is nothing to send.", "empty");
  if (items.length > MAX_SECRET_ITEMS) throw new ArtifactError(`At most ${MAX_SECRET_ITEMS} items can be sent at once.`, "too_many");
  for (const item of items) {
    if (!item.name.trim() || item.name.length > MAX_SECRET_NAME) throw new ArtifactError(`Each name must be 1 to ${MAX_SECRET_NAME} characters.`, "bad_name");
    if (item.value === "") throw new ArtifactError(`${item.name} is empty.`, "empty_value");
    if (item.value.length > MAX_SECRET_VALUE) throw new ArtifactError(`${item.name} is longer than ${MAX_SECRET_VALUE} characters.`, "too_large");
  }
}

/** Reads the items to send from a .env file, a JSON file, or any other text file (one item named after the file). */
export function readSecretItems(filePath: string, keys?: KeySelection): SecretItem[] {
  const path = resolve(filePath);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ArtifactError(`${path} cannot be read.`, "file_not_found");
  }
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const items = ext === ".json"
    ? parseJson(text)
    : ext === ".env" || name === ".env" || name.startsWith(".env.")
      ? parseEnv(text)
      : [{ name, value: text.replace(/\r?\n$/, "") }];
  const selected = selectItems(items, keys);
  validateItems(selected);
  return selected;
}
