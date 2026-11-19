import { SECRET_CRYPTO_JS, SECRET_LINK_KEY, secretEnvelopeSchema, secretShareEnvelopeSchema } from "@artifact/shared";
import type { webcrypto } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactError } from "../src/client.ts";
import { encryptForLink, encryptForRecipient, fingerprint, parseEnv, parseJson, readSecretItems, selectItems, validateItems } from "../src/secret.ts";

/** The exact code the recipient's browser runs (/assets/secret.js), evaluated in Node. */
interface BrowserCrypto {
  generate(): Promise<{ privateKey: webcrypto.CryptoKey; publicKey: string }>;
  fingerprint(publicKey: string): Promise<string>;
  decrypt(privateKey: webcrypto.CryptoKey, publicKey: string, id: string, envelope: unknown): Promise<unknown>;
  shareKey(linkSecret: string): Promise<webcrypto.CryptoKey>;
  openShare(key: webcrypto.CryptoKey, inner: unknown): Promise<unknown>;
}
const browser = new Function(`${SECRET_CRYPTO_JS}; return secretCrypto;`)() as BrowserCrypto;

const SECRET_VALUE = "s3cr3t-Value-0123456789";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ArtifactError);
    return (e as Error).message;
  }
  throw new Error("expected an error");
}

describe("encryption", () => {
  it("is decrypted by the browser's code, and both sides show the same fingerprint", async () => {
    const recipient = await browser.generate();
    const plaintext = { items: [{ name: "notify@example.com", value: SECRET_VALUE }, { name: "日本語の名前", value: "値 ✓" }] };
    const envelope = await encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, plaintext);
    expect(secretEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(SECRET_VALUE);
    expect(await browser.decrypt(recipient.privateKey, recipient.publicKey, "abcdefghjkmnpqrs", envelope)).toEqual(plaintext);
    expect(await fingerprint(recipient.publicKey)).toBe(await browser.fingerprint(recipient.publicKey));
    expect(await fingerprint(recipient.publicKey)).toMatch(/^\d{4} \d{4} \d{4}$/);
  });

  it("cannot be opened for another request, by another key, or after tampering", async () => {
    const recipient = await browser.generate();
    const other = await browser.generate();
    const envelope = await encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, { items: [{ name: "a", value: "b" }] });
    await expect(browser.decrypt(recipient.privateKey, recipient.publicKey, "zzzzzzzzzzzzzzzz", envelope)).rejects.toThrow();
    await expect(browser.decrypt(other.privateKey, other.publicKey, "abcdefghjkmnpqrs", envelope)).rejects.toThrow();
    const ct = Buffer.from(envelope.ct, "base64url");
    ct[0]! ^= 1;
    await expect(browser.decrypt(recipient.privateKey, recipient.publicKey, "abcdefghjkmnpqrs", { ...envelope, ct: ct.toString("base64url") })).rejects.toThrow();
  });

  it("uses a fresh key and IV every time", async () => {
    const recipient = await browser.generate();
    const a = await encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, { items: [{ name: "a", value: "b" }] });
    const b = await encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, { items: [{ name: "a", value: "b" }] });
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
  });

  it("refuses more than 16 KB", async () => {
    const recipient = await browser.generate();
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `k${i}`, value: "x".repeat(4000) }));
    await expect(encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, { items })).rejects.toThrow(/at most 16384/);
  });
});

describe("share links", () => {
  it("are opened by the browser's code with the part after #, and nothing else", async () => {
    const plaintext = { items: [{ name: "manage@example.com", value: SECRET_VALUE }] };
    const { linkSecret, envelope } = await encryptForLink(plaintext);
    expect(linkSecret).toMatch(SECRET_LINK_KEY);
    expect(secretShareEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(SECRET_VALUE);
    const key = await browser.shareKey(linkSecret);
    expect(key.extractable).toBe(false);
    expect(await browser.openShare(key, envelope)).toEqual(plaintext);

    const other = await encryptForLink(plaintext);
    expect(other.linkSecret).not.toBe(linkSecret);
    await expect(browser.openShare(await browser.shareKey(other.linkSecret), envelope)).rejects.toThrow();
    const ct = Buffer.from(envelope.ct, "base64url");
    ct[0]! ^= 1;
    await expect(browser.openShare(key, { ...envelope, ct: ct.toString("base64url") })).rejects.toThrow();
  });

  it("still read after the server wraps them for the browser that opened the link", async () => {
    // The Worker wraps the inner envelope with envelope v1 for the browser's key (the same algorithm as encryptForRecipient).
    const plaintext = { items: [{ name: "a", value: SECRET_VALUE }] };
    const { linkSecret, envelope } = await encryptForLink(plaintext);
    const recipient = await browser.generate();
    const wrapped = await encryptForRecipient("abcdefghjkmnpqrs", recipient.publicKey, envelope as never);
    const inner = await browser.decrypt(recipient.privateKey, recipient.publicKey, "abcdefghjkmnpqrs", wrapped);
    expect(await browser.openShare(await browser.shareKey(linkSecret), inner)).toEqual(plaintext);
  });

  it("refuses more than 16 KB", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `k${i}`, value: "x".repeat(4000) }));
    await expect(encryptForLink({ items })).rejects.toThrow(/at most 16384/);
  });
});

describe("reading values", () => {
  it("parses .env lines", () => {
    const text = `# comment\n\nexport A=one\nB = "two words"\nC='three # not a comment'\nD=four # comment\nE="line\\nbreak"\n`;
    expect(parseEnv(text)).toEqual([
      { name: "A", value: "one" },
      { name: "B", value: "two words" },
      { name: "C", value: "three # not a comment" },
      { name: "D", value: "four" },
      { name: "E", value: "line\nbreak" },
    ]);
    expect(messageOf(() => parseEnv(`OK=1\nnot a pair ${SECRET_VALUE}`))).toBe("Line 2 is not KEY=VALUE.");
  });

  it("parses both JSON shapes", () => {
    expect(parseJson('{"A":"1","B":2}')).toEqual([{ name: "A", value: "1" }, { name: "B", value: "2" }]);
    expect(parseJson('{"items":[{"name":"x","value":"y"}]}')).toEqual([{ name: "x", value: "y" }]);
    expect(() => parseJson("[1]")).toThrow(ArtifactError);
  });

  it("selects and renames keys, and names missing ones without showing values", () => {
    const items = [{ name: "A", value: SECRET_VALUE }, { name: "B", value: "two" }];
    expect(selectItems(items, ["B"])).toEqual([{ name: "B", value: "two" }]);
    expect(selectItems(items, { A: "notify@example.com" })).toEqual([{ name: "notify@example.com", value: SECRET_VALUE }]);
    const message = messageOf(() => selectItems(items, ["C"]));
    expect(message).toBe("The file has no C. It has: A, B.");
    expect(message).not.toContain(SECRET_VALUE);
  });

  it("validates without echoing values", () => {
    expect(messageOf(() => validateItems([{ name: "A", value: "" }]))).toBe("A is empty.");
    expect(messageOf(() => validateItems([{ name: "A", value: "x".repeat(5000) }]))).not.toContain("xxxx");
    expect(() => validateItems([])).toThrow(ArtifactError);
  });

  it("reads a .env file, or a text file as one item", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-secret-"));
    writeFileSync(join(dir, "mail.env"), `# notify\nNOTIFY_PASSWORD=${SECRET_VALUE}\nQA_PASSWORD=qa\n`);
    expect(readSecretItems(join(dir, "mail.env"), { NOTIFY_PASSWORD: "notify@example.com" })).toEqual([{ name: "notify@example.com", value: SECRET_VALUE }]);
    writeFileSync(join(dir, "token.txt"), `${SECRET_VALUE}\n`);
    expect(readSecretItems(join(dir, "token.txt"))).toEqual([{ name: "token.txt", value: SECRET_VALUE }]);
    expect(messageOf(() => readSecretItems(join(dir, "missing.env")))).toMatch(/cannot be read/);
  });
});
