import { base64url, fromBase64url, sha256Hex, utf8 } from "../lib/encoding.ts";

/** Google OpenID Connect: authorization code flow with PKCE, verified in the Worker. */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier))));
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
}

export async function exchangeCode(p: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: "authorization_code",
      code_verifier: p.codeVerifier,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new Error("Google returned no id_token");
  return body.id_token;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

let jwksCache: { keys: Jwk[]; expires: number } | undefined;

async function googleKeys(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Could not fetch Google's signing keys (${res.status})`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys, expires: Date.now() + maxAge * 1000 };
  return keys;
}

/** Verifies the ID token's RS256 signature, issuer, audience, expiry and nonce. */
export async function verifyIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  keys: () => Promise<Jwk[]> = googleKeys,
): Promise<IdTokenClaims> {
  const [headerPart, payloadPart, sigPart] = idToken.split(".");
  if (!headerPart || !payloadPart || !sigPart) throw new Error("Malformed ID token");
  const header = JSON.parse(new TextDecoder().decode(fromBase64url(headerPart))) as { alg: string; kid: string };
  if (header.alg !== "RS256") throw new Error(`Unexpected ID token algorithm ${header.alg}`);
  const jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("ID token signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64url(sigPart), utf8(`${headerPart}.${payloadPart}`));
  if (!ok) throw new Error("ID token signature is invalid");
  const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payloadPart))) as IdTokenClaims;
  if (!ISSUERS.has(claims.iss)) throw new Error("ID token issuer is not Google");
  if (claims.aud !== expected.clientId) throw new Error("ID token audience does not match");
  if (claims.exp * 1000 <= Date.now()) throw new Error("ID token has expired");
  if (claims.nonce !== (await sha256Hex(expected.nonce))) throw new Error("ID token nonce does not match");
  return claims;
}
