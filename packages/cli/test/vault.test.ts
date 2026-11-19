import { vaultContext, vaultEnvelopeSchema, vaultSealedSchema } from "@artifact/shared";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ArtifactError } from "../src/client.ts";
import { deleteVaultKey, loadVaultKeyJson, saveVaultKeyJson } from "../src/keystore.ts";
import {
  fromUtf8,
  generateKeyPair,
  importPrivateKey,
  newDataKey,
  newRecoverySecret,
  open,
  parsePrivateJwk,
  parseRecoverySecret,
  publicKeyOfJwk,
  recoveryKeyBytes,
  seal,
  unwrapWith,
  utf8,
  wrapTo,
} from "../src/vault-crypto.ts";

describe("vault crypto", () => {
  it("wraps for a public key and only the matching private key and context open it", async () => {
    const device = await generateKeyPair();
    const collection = await generateKeyPair();
    const context = vaultContext.collectionKey("medishare-prod", 1, "member1");
    const envelope = await wrapTo(device.publicKey, context, utf8(JSON.stringify(collection.privateJwk)));
    expect(vaultEnvelopeSchema.safeParse(envelope).success).toBe(true);

    const privateKey = await importPrivateKey(device.privateJwk);
    const opened = parsePrivateJwk(fromUtf8(await unwrapWith(privateKey, device.publicKey, context, envelope)));
    expect(opened.d).toBe(collection.privateJwk.d);

    await expect(unwrapWith(privateKey, device.publicKey, vaultContext.collectionKey("medishare-prod", 1, "member2"), envelope)).rejects.toThrow(ArtifactError);
    const other = await importPrivateKey((await generateKeyPair()).privateJwk);
    await expect(unwrapWith(other, device.publicKey, context, envelope)).rejects.toThrow(ArtifactError);
  });

  it("seals a value under a data key, bound to collection, secret and version", async () => {
    const dek = newDataKey();
    const context = vaultContext.value("medishare-prod", "RESEND_API_KEY", 3);
    const sealed = await seal(dek, context, utf8("re_123"));
    expect(vaultSealedSchema.safeParse(sealed).success).toBe(true);
    expect(fromUtf8(await open(dek, context, sealed))).toBe("re_123");
    await expect(open(dek, vaultContext.value("medishare-prod", "RESEND_API_KEY", 4), sealed)).rejects.toThrow("could not be opened");
    await expect(open(newDataKey(), context, sealed)).rejects.toThrow(ArtifactError);
  });

  it("derives the public key from a private JWK", async () => {
    const pair = await generateKeyPair();
    expect(publicKeyOfJwk(pair.privateJwk)).toBe(pair.publicKey);
    expect(() => parsePrivateJwk('{"kty":"RSA"}')).toThrow(ArtifactError);
  });

  it("shows the recovery secret as groups of Crockford base32 and reads it back leniently", async () => {
    const recovery = newRecoverySecret();
    expect(recovery.display).toMatch(/^([0-9a-hjkmnp-tv-z]{4}-){12}[0-9a-hjkmnp-tv-z]{4}$/);
    expect(parseRecoverySecret(recovery.display)).toEqual(recovery.bytes);
    const sloppy = recovery.display.toUpperCase().replace(/-/g, " ").replace(/0/g, "O").replace(/1/g, "I");
    expect(parseRecoverySecret(sloppy)).toEqual(recovery.bytes);
    expect(() => parseRecoverySecret("abcd")).toThrow(/characters/);
    expect(() => parseRecoverySecret(recovery.display.replace(/^./, "u"))).toThrow(/not part/);

    const key1 = await recoveryKeyBytes(recovery.bytes);
    const key2 = await recoveryKeyBytes(parseRecoverySecret(recovery.display));
    expect(key1).toEqual(key2);
    expect(key1.length).toBe(32);
    const owner = await generateKeyPair();
    const wrapped = await seal(key1, vaultContext.ownerKey("recovery"), utf8(JSON.stringify(owner.privateJwk)));
    expect(parsePrivateJwk(fromUtf8(await open(key2, vaultContext.ownerKey("recovery"), wrapped))).d).toBe(owner.privateJwk.d);
  });
});

describe("keystore (file fallback)", () => {
  beforeEach(() => {
    process.env["XDG_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "artifact-vault-test-"));
    process.env["ARTIFACT_KEYRING"] = "file";
  });

  it("keeps the device key in a 0600 file when there is no keyring, and deletes it", async () => {
    expect(await loadVaultKeyJson()).toBeUndefined();
    const json = JSON.stringify((await generateKeyPair()).privateJwk);
    expect(await saveVaultKeyJson(json)).toBe("file");
    const path = join(process.env["XDG_CONFIG_HOME"]!, "artifact", "default", "vault-key.json");
    expect(readFileSync(path, "utf8")).toBe(json);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await loadVaultKeyJson()).toEqual({ json, store: "file" });
    await deleteVaultKey();
    expect(await loadVaultKeyJson()).toBeUndefined();
  });
});
