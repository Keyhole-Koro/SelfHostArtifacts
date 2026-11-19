import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { profileDir, profileName, writePrivateFile } from "./profile.ts";

/**
 * Where the device's vault key (a P-256 private key as JWK JSON) lives: the operating system's
 * keyring when there is one (GNOME Keyring / KWallet through libsecret, the macOS Keychain, the
 * Windows Credential Manager, via @napi-rs/keyring), else a 0600 file in the profile directory.
 * `ARTIFACT_KEYRING=file` forces the file, for servers without a keyring and for tests.
 */

export type KeyStore = "keyring" | "file";

const SERVICE = "artifact";
const account = () => `${profileName()}/vault-key`;
const filePath = () => join(profileDir(), "vault-key.json");

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

async function keyringEntry(): Promise<KeyringEntry | null> {
  if (process.env["ARTIFACT_KEYRING"] === "file") return null;
  try {
    const mod = (await import("@napi-rs/keyring")) as { Entry: new (service: string, user: string) => KeyringEntry };
    return new mod.Entry(SERVICE, account());
  } catch {
    return null;
  }
}

/** Reads from the keyring first, then the file. */
export async function loadVaultKeyJson(): Promise<{ json: string; store: KeyStore } | undefined> {
  const entry = await keyringEntry();
  if (entry) {
    try {
      const json = entry.getPassword();
      if (json) return { json, store: "keyring" };
    } catch {
      // no usable keyring on this machine (no D-Bus session, locked, …): fall through to the file
    }
  }
  const path = filePath();
  if (existsSync(path)) return { json: readFileSync(path, "utf8"), store: "file" };
  return undefined;
}

/** Keeps the key in the keyring when it works, else in the file. Returns where it went. */
export async function saveVaultKeyJson(json: string): Promise<KeyStore> {
  const entry = await keyringEntry();
  if (entry) {
    try {
      entry.setPassword(json);
      if (entry.getPassword() === json) {
        if (existsSync(filePath())) unlinkSync(filePath());
        return "keyring";
      }
    } catch {
      // fall back to the file
    }
  }
  writePrivateFile(filePath(), json);
  return "file";
}

export async function deleteVaultKey(): Promise<void> {
  const entry = await keyringEntry();
  if (entry) {
    try {
      entry.deletePassword();
    } catch {
      // nothing stored there
    }
  }
  if (existsSync(filePath())) unlinkSync(filePath());
}
