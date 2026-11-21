import { describe, expect, it } from "vitest";
import { base64url, fromBase64url, utf8 } from "../src/lib/encoding.ts";
import { sign, verify } from "../src/lib/signed.ts";

const SECRET = "test-signing-secret";
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
/** Ten minutes after NOW, in unix seconds, like a content token. */
const EXP = NOW / 1000 + 600;

/** body "." a correct MAC of it: reaches the checks that come after the MAC. */
async function withValidMac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body))))}`;
}

function parts(token: string): [body: string, mac: string] {
  const dot = token.indexOf(".");
  return [token.slice(0, dot), token.slice(dot + 1)];
}

describe("sign and verify", () => {
  it("give back the payload that was signed", async () => {
    const payload = { a: "x7k2m9q4p1r8t3v6", v: 3, exp: EXP, u: "user1" };
    const token = await sign(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(await verify(token, SECRET, NOW)).toEqual(payload);
  });

  it("refuse another payload under the MAC", async () => {
    const [, mac] = parts(await sign({ a: "mine", v: 1, exp: EXP }, SECRET));
    const other = base64url(utf8(JSON.stringify({ a: "theirs", v: 1, exp: EXP })));
    expect(await verify(`${other}.${mac}`, SECRET, NOW)).toBeUndefined();
  });

  it("refuse a changed, shortened or empty MAC", async () => {
    const [body, mac] = parts(await sign({ a: "x", v: 1, exp: EXP }, SECRET));
    const bytes = fromBase64url(mac);
    bytes[0] = bytes[0]! ^ 1;
    expect(await verify(`${body}.${base64url(bytes)}`, SECRET, NOW)).toBeUndefined();
    expect(await verify(`${body}.${base64url(fromBase64url(mac).slice(0, 31))}`, SECRET, NOW)).toBeUndefined();
    expect(await verify(`${body}.`, SECRET, NOW)).toBeUndefined();
  });

  it("refuse a token signed with another secret", async () => {
    const token = await sign({ a: "x", v: 1, exp: EXP }, "another-secret");
    expect(await verify(token, SECRET, NOW)).toBeUndefined();
    expect(await verify(token, "another-secret", NOW)).toBeDefined();
  });

  it("stop working at exp", async () => {
    const token = await sign({ a: "x", v: 1, exp: EXP }, SECRET);
    expect(await verify(token, SECRET, EXP * 1000 - 1)).toBeDefined();
    expect(await verify(token, SECRET, EXP * 1000)).toBeUndefined();
    expect(await verify(token, SECRET, EXP * 1000 + 60_000)).toBeUndefined();
  });

  it("refuse a payload whose exp is missing or not a number", async () => {
    for (const payload of [{ a: "x" }, { a: "x", exp: String(EXP) }, { a: "x", exp: null }]) {
      expect(await verify(await sign(payload, SECRET), SECRET, NOW), JSON.stringify(payload)).toBeUndefined();
    }
  });

  it("refuse a token without a body before its dot", async () => {
    const [, mac] = parts(await sign({ a: "x", v: 1, exp: EXP }, SECRET));
    for (const token of ["", "no-dot-at-all", `.${mac}`]) expect(await verify(token, SECRET, NOW), token).toBeUndefined();
  });

  it("refuse a MAC or a body that is not base64url, or a body that is not JSON, without throwing", async () => {
    const [body] = parts(await sign({ a: "x", v: 1, exp: EXP }, SECRET));
    expect(await verify(`${body}.not*base64!`, SECRET, NOW)).toBeUndefined();
    expect(await verify(await withValidMac("not*base64!"), SECRET, NOW)).toBeUndefined();
    expect(await verify(await withValidMac(base64url(utf8("not json"))), SECRET, NOW)).toBeUndefined();
  });
});
