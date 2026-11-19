import { SECRET_INFO, type SecretEnvelope } from "@artifact/shared";
import { base64url, fromBase64url, utf8 } from "./encoding.ts";

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/**
 * Envelope v1 for a recipient's public key, the same as the CLI's encryptForRecipient (see
 * @artifact/shared secret.ts): one-time ECDH P-256 → HKDF-SHA256 → AES-256-GCM. The Worker uses it
 * in share mode to wrap the inner envelope, which it cannot read, for the browser that opened the link.
 */
export async function sealForRecipient(id: string, recipientPublicKey: string, data: Uint8Array<ArrayBuffer>): Promise<SecretEnvelope> {
  const rpk = fromBase64url(recipientPublicKey);
  const recipient = await crypto.subtle.importKey("raw", rpk, P256, false, []);
  const sender = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
  // The standard name is `public`; workers-types spells it `$public` only because `public` is reserved in its generator.
  const ecdh = { name: "ECDH", public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const bits = await crypto.subtle.deriveBits(ecdh, sender.privateKey, 256);
  const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array(epk.length + rpk.length);
  salt.set(epk);
  salt.set(rpk, epk.length);
  const context = utf8(`${SECRET_INFO}\0${id}`);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: context }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, data));
  return { v: 1, epk: base64url(epk), iv: base64url(iv), ct: base64url(ct) };
}
