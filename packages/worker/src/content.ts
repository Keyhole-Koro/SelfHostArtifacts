import { leaseLive, renewLease } from "./db/leases.ts";
import { randomId } from "./lib/encoding.ts";
import { sign, verify } from "./lib/signed.ts";

/**
 * Lifetime of the token in /c/:token/, and of each renewal of its lease. A token in the frame
 * of a viewer page has a lease: the page renews it while it is open, so the frame keeps its URL
 * and the page in it is never reloaded. Any other token (a new tab, an editor) just runs out.
 */
export const CONTENT_TOKEN_SECONDS = 10 * 60;

export interface ContentToken {
  a: string; // artifact id
  v: number; // version
  exp: number; // unix seconds
  s?: string; // share nonce, for tokens minted by a public link; checked on every request
  u?: string; // the user a viewer token was minted for: macros show only what they may see
  l?: string; // lease id: after `exp` the token serves while content_leases says so
}

export async function mintContentToken(
  secret: string,
  artifactId: string,
  version: number,
  shareNonce?: string,
  userId?: string,
  leased = false,
): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + CONTENT_TOKEN_SECONDS;
  const claims: ContentToken = shareNonce ? { a: artifactId, v: version, exp, s: shareNonce } : { a: artifactId, v: version, exp, ...(userId ? { u: userId } : {}) };
  if (leased) claims.l = randomId();
  return { token: await sign(claims, secret), exp };
}

/** The claims of a token that may be used now: it has not run out, or its lease has not ended. */
export async function readContentToken(db: D1Database, secret: string, token: string, now = Date.now()): Promise<ContentToken | undefined> {
  const claims = await signedContentClaims(secret, token);
  if (!claims) return undefined;
  if (claims.exp * 1000 > now) return claims;
  return claims.l !== undefined && (await leaseLive(db, claims.l, now)) ? claims : undefined;
}

/** The claims of a token we signed, whether or not it has run out: for renewing its lease. */
export function signedContentClaims(secret: string, token: string): Promise<ContentToken | undefined> {
  return verify<ContentToken>(token, secret, 0); // a clock at 0 passes every expiry
}

/** Keeps a leased token serving for another CONTENT_TOKEN_SECONDS; returns when that ends. */
export async function renewContentLease(db: D1Database, lease: string): Promise<number> {
  const exp = Math.floor(Date.now() / 1000) + CONTENT_TOKEN_SECONDS;
  await renewLease(db, lease, exp);
  return exp;
}

/** Libraries that artifacts may load. Keep in sync with skills/selfhost-artifact-design/references/libraries.md. */
export const SCRIPT_CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"];
const STYLE_HOSTS = [...SCRIPT_CDNS, "https://fonts.googleapis.com"];
const FONT_HOSTS = [...SCRIPT_CDNS, "https://fonts.gstatic.com"];

/**
 * The sandbox flags of the artifact frame. `allow-same-origin` is deliberately absent: the
 * page runs in an opaque origin, so it cannot read our cookies, our DOM or call our API as
 * the signed-in user, even though it is served from the same host.
 *
 * `allow-popups-to-escape-sandbox` lets a link with target="_blank" open an ordinary tab.
 * Without it the new tab inherits this sandbox, so another artifact or the sign-in page opened
 * from a link runs in an opaque origin and passkey sign-in fails with "Failed to fetch". The
 * page itself stays sandboxed, and anything under /c/ opened in that tab is sandboxed again by
 * its own Content-Security-Policy.
 */
export const SANDBOX_FLAGS = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

export function contentSecurityPolicy(allowConnect: string[]): string {
  const connect = ["'self'", ...allowConnect.map((h) => `https://${h}`)];
  return [
    `sandbox ${SANDBOX_FLAGS}`,
    "default-src 'self' data: blob:",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${SCRIPT_CDNS.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${STYLE_HOSTS.join(" ")}`,
    `font-src 'self' data: ${FONT_HOSTS.join(" ")}`,
    `img-src 'self' data: blob: ${SCRIPT_CDNS.join(" ")}`,
    "media-src 'self' data: blob:",
    `connect-src ${connect.join(" ")}`,
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
  ].join("; ");
}

export function contentHeaders(contentType: string, allowConnect: string[]): Headers {
  return new Headers({
    "content-type": contentType,
    "content-security-policy": contentSecurityPolicy(allowConnect),
    // Requests from the opaque origin are cross-origin; the token in the path is the authorization.
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "cross-origin",
  });
}
