import { base64url, fromBase64url, utf8 } from "./encoding.ts";

/**
 * Small HMAC-signed payloads: the content token in /c/:token/ and the OAuth state cookie.
 * Format: base64url(json) "." base64url(hmac-sha256)
 */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(payload: object, secret: string): Promise<string> {
  const body = base64url(utf8(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body));
  return `${body}.${base64url(new Uint8Array(mac))}`;
}

/** The payload when the signature is valid and `exp` (unix seconds) has not passed. */
export async function verify<T extends { exp: number }>(token: string, secret: string, now = Date.now()): Promise<T | undefined> {
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  let mac: Uint8Array<ArrayBuffer>;
  try {
    mac = fromBase64url(token.slice(dot + 1));
  } catch {
    return undefined;
  }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), mac, utf8(body));
  if (!ok) return undefined;
  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
  } catch {
    return undefined;
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return undefined;
  return payload;
}
