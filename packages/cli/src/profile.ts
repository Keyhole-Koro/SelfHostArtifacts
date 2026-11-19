import { closeSync, constants, existsSync, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Everything the CLI keeps on disk, per profile:
 *   ~/.config/artifact/<profile>/config.json  host and device id
 *   ~/.config/artifact/<profile>/key.pem      the device's Ed25519 private key (0600)
 *   ~/.config/artifact/<profile>/state.json   which local file was published as which artifact
 */

export interface ProfileConfig {
  host: string;
  device_id?: string;
  device_name?: string;
  /** The vault member id and encryption public key registered for this device (`artifact vault key`). */
  vault_member_id?: string;
  vault_public_key?: string;
}

export interface PublishedFile {
  id: string;
  url: string;
  version: number;
}

export interface State {
  files: Record<string, PublishedFile>;
}

export function configRoot(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "artifact");
}

export function profileName(): string {
  return process.env["ARTIFACT_PROFILE"] || "default";
}

export function profileDir(profile = profileName()): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(profile)) throw new Error(`Profile names use letters, digits, - and _ only: "${profile}"`);
  return join(configRoot(), profile);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Writes through a temporary file so a crash never leaves half a JSON file behind. */
function writeJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, path);
}

export const paths = {
  config: () => join(profileDir(), "config.json"),
  key: () => join(profileDir(), "key.pem"),
  state: () => join(profileDir(), "state.json"),
};

export function loadConfig(): ProfileConfig | undefined {
  return readJson<ProfileConfig>(paths.config());
}

export function saveConfig(config: ProfileConfig): void {
  writeJson(paths.config(), config);
}

export function loadState(): State {
  return readJson<State>(paths.state()) ?? { files: {} };
}

export function rememberPublish(localPath: string, published: PublishedFile): void {
  const state = loadState();
  state.files[localPath] = published;
  writeJson(paths.state(), state);
}

export function forgetArtifact(id: string): void {
  const state = loadState();
  for (const [path, entry] of Object.entries(state.files)) if (entry.id === id) delete state.files[path];
  writeJson(paths.state(), state);
}

/**
 * Writes `contents` to a 0600 file. An existing file is made 0600 before anything goes in: the mode
 * given to open applies only when it creates the file, and fchmod on someone else's file throws first.
 */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
  try {
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

export function originFor(host: string): string {
  const name = host.replace(/:\d+$/, "");
  const local = name === "localhost" || name === "127.0.0.1" || name === "[::1]";
  return `${local ? "http" : "https"}://${host}`;
}
