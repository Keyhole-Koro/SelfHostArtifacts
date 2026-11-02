import { base64url, fromBase64url, randomToken, utf8 } from "./lib/encoding.ts";

/** How long a public link stays open after it is created or extended. */
export const SHARE_DAYS = 30;

export interface Shareable {
  id: string;
  share_nonce: string | null;
  share_expires_at: string | null;
}

async function shareHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Domain-separated from content tokens, which are signed with the same secret. */
const message = (id: string, nonce: string) => utf8(`share-link\0${id}\0${nonce}`);

export async function shareKey(secret: string, id: string, nonce: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await shareHmacKey(secret), message(id, nonce));
  return base64url(new Uint8Array(mac));
}

export function newShareNonce(): string {
  return randomToken();
}

export function shareExpiry(now = Date.now()): string {
  return new Date(now + SHARE_DAYS * 864e5).toISOString();
}

/** True when the artifact has a public link that has not expired. */
export function shareActive(a: Shareable, now = Date.now()): a is Shareable & { share_nonce: string; share_expires_at: string } {
  return a.share_nonce !== null && a.share_expires_at !== null && Date.parse(a.share_expires_at) > now;
}

/** Checks the key from /s/:id/:key against the artifact's current link (constant time). */
export async function shareKeyValid(secret: string, a: Shareable, key: string, now = Date.now()): Promise<boolean> {
  if (!shareActive(a, now)) return false;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64url(key);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await shareHmacKey(secret), mac, message(a.id, a.share_nonce));
}

export function sharePath(id: string, key: string): string {
  return `/s/${id}/${key}`;
}
