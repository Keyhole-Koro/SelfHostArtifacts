import { describe, expect, it } from "vitest";
import { verifyIdToken } from "../src/auth/google.ts";
import { base64url, sha256Hex, utf8 } from "../src/lib/encoding.ts";

const CLIENT_ID = "client.apps.googleusercontent.com";

async function issuer() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
  async function token(claims: Record<string, unknown>) {
    const header = base64url(utf8(JSON.stringify({ alg: "RS256", kid: "k1" })));
    const payload = base64url(utf8(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, utf8(`${header}.${payload}`));
    return `${header}.${payload}.${base64url(new Uint8Array(sig))}`;
  }
  return { keys: async () => [jwk], token };
}

async function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: "root@example.com",
    email_verified: true,
    nonce: await sha256Hex("raw-nonce"),
    ...overrides,
  };
}

describe("verifyIdToken", () => {
  it("accepts a valid token", async () => {
    const { keys, token } = await issuer();
    const result = await verifyIdToken(await token(await claims()), { clientId: CLIENT_ID, nonce: "raw-nonce" }, keys);
    expect(result.email).toBe("root@example.com");
  });

  it.each([
    ["another audience", { aud: "other" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: 1 }],
    ["a different nonce", { nonce: "x" }],
  ])("rejects %s", async (_, overrides) => {
    const { keys, token } = await issuer();
    await expect(verifyIdToken(await token(await claims(overrides)), { clientId: CLIENT_ID, nonce: "raw-nonce" }, keys)).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    const a = await issuer();
    const b = await issuer();
    await expect(verifyIdToken(await b.token(await claims()), { clientId: CLIENT_ID, nonce: "raw-nonce" }, a.keys)).rejects.toThrow(
      "signature",
    );
  });
});
