// Renders wrangler.local.toml (the deployment's config) from wrangler.toml. Used by deploy.mjs
// and, in GitHub Actions, by write-config.mjs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LOCAL = "wrangler.local.toml";
/** The Vectorize index for search by meaning: bge-m3 vectors, compared by cosine. */
export const VECTOR_INDEX = "artifacts-pages";
export const VECTOR_DIMENSIONS = 1024;

/**
 * Calls `use` (synchronously) with the path of a JSON file holding `secrets`, for
 * `wrangler secret bulk`, and removes it afterwards, also when `use` throws. The file is created
 * exclusively (0600) in a new directory that only we can open (0700), so nothing planted under a
 * predictable name in a shared temp directory can receive the values.
 */
export function withSecretsFile(secrets, use) {
  const dir = mkdtempSync(join(tmpdir(), "artifact-secrets-"));
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(name, value, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} looks wrong: "${value}"`);
  return value;
}

export function renderConfig({ host, keep = "0", trash = "30", dbId }) {
  check("APP_HOST", host, /^[a-z0-9.-]+\.[a-z]{2,}$/);
  check("KEEP_VERSIONS", keep, /^\d+$/);
  check("TRASH_DAYS", trash, /^\d+$/);
  check("D1 database id", dbId, /^[0-9a-f-]{36}$|^<.*>$/);
  const base = readFileSync("wrangler.toml", "utf8")
    .replace(/^APP_HOST = .*$/m, `APP_HOST = "${host}"`)
    .replace(/^KEEP_VERSIONS = .*$/m, `KEEP_VERSIONS = "${keep}"`)
    .replace(/^TRASH_DAYS = .*$/m, `TRASH_DAYS = "${trash}"`)
    .replace(/^# Skips sign-in.*\n.*\n/m, "") // comment line + DEV_LOGIN: never in a deployment
    .replace(/^database_id = .*$/m, `database_id = "${dbId}"`)
    .replace(/^# Development defaults[\s\S]*?\n(?=name = )/m, "");
  // Search by meaning: Workers AI embeds the pages into a Vectorize index (src/db/semantic.ts).
  // Only deployments have them, so tests and wrangler dev search by words alone.
  return `# Generated from wrangler.toml. Not committed: it holds your hostname and account's resource ids.\n${base}
[[routes]]
pattern = "${host}"
custom_domain = true

[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORS"
index_name = "${VECTOR_INDEX}"
`;
}
