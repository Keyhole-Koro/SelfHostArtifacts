const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// Crockford base32 without I, L, O, U: easy to read aloud and safe in URLs.
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

export function randomBase32(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE32[b % 32]).join("");
}

/** Random id for artifacts and devices (80 bits). */
export function randomId(): string {
  return randomBase32(16);
}

/** Random secret for sessions, nonces and CSRF tokens (256 bits). */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** Pairing code shown in the terminal and on the approval page, e.g. "KX7P-M2QD". */
export function pairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
