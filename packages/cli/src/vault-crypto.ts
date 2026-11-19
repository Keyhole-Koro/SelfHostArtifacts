import { vaultContext, type VaultEnvelope, type VaultSealed } from "@artifact/shared";
import { webcrypto } from "node:crypto";
import { ArtifactError } from "./client.ts";

/**
 * The cryptography of the vault, on the device (see @artifact/shared vault.ts for the layers).
 * Everything here runs in Node's Web Crypto; the Worker only stores what comes out.
 *
 * - P-256 key pairs for devices, the owner and collections. Private keys travel as JWK JSON, either
 *   into the keystore (the device key) or wrapped for someone's public key (collection and owner keys).
 * - wrapTo / unwrapWith: envelope v1 (one-time ECDH P-256 → HKDF-SHA256 → AES-256-GCM) for a public key.
 * - seal / open: AES-256-GCM under a 32-byte key (a data key, or the key from the recovery secret).
 * - The recovery secret: 32 random bytes, shown once as 13 groups of Crockford base32.
 */

const subtle = webcrypto.subtle;
const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export interface VaultKeyPair {
  /** Raw uncompressed point, base64url: what the server stores and what others wrap to. */
  publicKey: string;
  /** The private key as JWK (kty EC, crv P-256, x, y, d). Keep it in the keystore or wrapped. */
  privateJwk: webcrypto.JsonWebKey;
}

export async function generateKeyPair(): Promise<VaultKeyPair> {
  const pair = (await subtle.generateKey(P256, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const privateJwk = (await subtle.exportKey("jwk", pair.privateKey)) as webcrypto.JsonWebKey;
  return { publicKey: b64(raw), privateJwk };
}

/** The raw public key that a private JWK belongs to (0x04 || x || y). */
export function publicKeyOfJwk(jwk: webcrypto.JsonWebKey): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new ArtifactError("The stored key is not a P-256 key.", "bad_key");
  const x = unb64(jwk.x);
  const y = unb64(jwk.y);
  const raw = new Uint8Array(1 + x.length + y.length);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  return b64(raw);
}

export function importPrivateKey(jwk: webcrypto.JsonWebKey): Promise<webcrypto.CryptoKey> {
  return subtle.importKey("jwk", jwk, P256, false, ["deriveBits"]);
}

export function parsePrivateJwk(json: string): webcrypto.JsonWebKey {
  let jwk: unknown;
  try {
    jwk = JSON.parse(json);
  } catch {
    throw new ArtifactError("The stored key is not valid JSON.", "bad_key");
  }
  const k = jwk as webcrypto.JsonWebKey;
  if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.d !== "string") throw new ArtifactError("The stored key is not a P-256 private key.", "bad_key");
  return k;
}

async function deriveWrapKey(bits: ArrayBuffer, salt: Uint8Array, context: string, usage: "encrypt" | "decrypt"): Promise<webcrypto.CryptoKey> {
  const ikm = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(context) }, ikm, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/** Envelope v1 for `publicKey`: the HKDF info and the additional data are `context` (see vaultContext). */
export async function wrapTo(publicKey: string, context: string, plaintext: Uint8Array): Promise<VaultEnvelope> {
  const rpk = unb64(publicKey);
  const recipient = await subtle.importKey("raw", rpk, P256, false, []);
  const sender = (await subtle.generateKey(P256, true, ["deriveBits"])) as webcrypto.CryptoKeyPair;
  const epk = new Uint8Array(await subtle.exportKey("raw", sender.publicKey));
  const bits = await subtle.deriveBits({ name: "ECDH", public: recipient }, sender.privateKey, 256);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const key = await deriveWrapKey(bits, salt, context, "encrypt");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, plaintext));
  return { v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
}

/** Opens an envelope made by wrapTo for `publicKey`, with its private key. */
export async function unwrapWith(privateKey: webcrypto.CryptoKey, publicKey: string, context: string, envelope: VaultEnvelope): Promise<Uint8Array> {
  if (envelope.v !== 1) throw new ArtifactError("Unsupported envelope.", "bad_envelope");
  const epk = unb64(envelope.epk);
  const rpk = unb64(publicKey);
  const sender = await subtle.importKey("raw", epk, P256, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const key = await deriveWrapKey(bits, salt, context, "decrypt");
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: encoder.encode(context) }, key, unb64(envelope.ct)));
  } catch {
    throw new ArtifactError("The wrapped key could not be opened with this device's key.", "cannot_open");
  }
}

export function newDataKey(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(32));
}

async function aesKey(keyBytes: Uint8Array, usage: "encrypt" | "decrypt"): Promise<webcrypto.CryptoKey> {
  if (keyBytes.length !== 32) throw new ArtifactError("A data key is 32 bytes.", "bad_key");
  return subtle.importKey("raw", keyBytes, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/** AES-256-GCM under `keyBytes`, with `context` as additional data. */
export async function seal(keyBytes: Uint8Array, context: string, plaintext: Uint8Array): Promise<VaultSealed> {
  const key = await aesKey(keyBytes, "encrypt");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, plaintext));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

export async function open(keyBytes: Uint8Array, context: string, sealed: VaultSealed): Promise<Uint8Array> {
  if (sealed.v !== 1) throw new ArtifactError("Unsupported envelope.", "bad_envelope");
  const key = await aesKey(keyBytes, "decrypt");
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv), additionalData: encoder.encode(context) }, key, unb64(sealed.ct)));
  } catch {
    throw new ArtifactError("The value could not be opened: wrong key, or the ciphertext was moved or damaged.", "cannot_open");
  }
}

// ---- the recovery secret ----

/** Crockford base32 (no I, L, O, U): read aloud without ambiguity. 32 bytes become 52 characters. */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string, bytes: number): Uint8Array {
  const normalized = text.toLowerCase().replace(/[\s-]/g, "").replace(/[il]/g, "1").replace(/o/g, "0");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of normalized) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new ArtifactError(`The recovery key has a character that is not part of it: "${ch}".`, "bad_recovery_key");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length !== bytes) throw new ArtifactError(`The recovery key should have ${Math.ceil((bytes * 8) / 5)} characters without the dashes.`, "bad_recovery_key");
  return Uint8Array.from(out);
}

export interface RecoverySecret {
  bytes: Uint8Array;
  /** What the person writes down: 13 groups of 4 characters, e.g. "7k2m-...". */
  display: string;
}

export function newRecoverySecret(): RecoverySecret {
  const bytes = webcrypto.getRandomValues(new Uint8Array(32));
  return { bytes, display: formatRecovery(base32Encode(bytes)) };
}

function formatRecovery(encoded: string): string {
  return encoded.match(/.{1,4}/g)!.join("-");
}

export function parseRecoverySecret(display: string): Uint8Array {
  return base32Decode(display, 32);
}

/** The AES key of the recovery secret: HKDF-SHA256 with no salt and the owner-key context as info. */
export async function recoveryKeyBytes(secret: Uint8Array, wrappedBy = "recovery"): Promise<Uint8Array> {
  const ikm = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(vaultContext.ownerKey(wrappedBy)) }, ikm, 256);
  return new Uint8Array(bits);
}

export const utf8 = (text: string) => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
