/**
 * Request signing for agents. The CLI signs every API request with the device's Ed25519 key:
 *
 *   Authorization: Article-Sig key=<deviceId>,ts=<unix seconds>,nonce=<random>,sig=<base64url>
 *   X-Article-Content-Sha256: <hex sha256 of the body>
 *
 * The signature covers METHOD, path with query, ts, nonce and the body hash, one per line.
 * For a blob upload the body hash is the blob's own hash, which R2 verifies on write.
 */

export const SIGNATURE_SCHEME = "Article-Sig";
export const CONTENT_HASH_HEADER = "x-article-content-sha256";
export const MAX_CLOCK_SKEW_SECONDS = 300;

/** sha256 of the empty string, used for requests without a body. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SignatureParams {
  key: string;
  ts: number;
  nonce: string;
  sig: string;
}

export function canonicalRequest(method: string, pathWithQuery: string, ts: number, nonce: string, bodySha256: string): string {
  return [method.toUpperCase(), pathWithQuery, String(ts), nonce, bodySha256].join("\n");
}

export function formatSignatureHeader(p: SignatureParams): string {
  return `${SIGNATURE_SCHEME} key=${p.key},ts=${p.ts},nonce=${p.nonce},sig=${p.sig}`;
}

const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

export function parseSignatureHeader(header: string | null | undefined): SignatureParams | undefined {
  if (!header?.startsWith(`${SIGNATURE_SCHEME} `)) return undefined;
  const fields = new Map<string, string>();
  for (const part of header.slice(SIGNATURE_SCHEME.length + 1).split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return undefined;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const key = fields.get("key");
  const nonce = fields.get("nonce");
  const sig = fields.get("sig");
  const ts = Number(fields.get("ts"));
  if (!key || !nonce || !sig || !Number.isSafeInteger(ts)) return undefined;
  if (!TOKEN.test(key) || !TOKEN.test(nonce) || !TOKEN.test(sig)) return undefined;
  return { key, ts, nonce, sig };
}
