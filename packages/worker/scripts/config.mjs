// Renders wrangler.local.toml (the deployment's config) from wrangler.toml. Used by deploy.mjs
// and, in GitHub Actions, by write-config.mjs.
import { readFileSync } from "node:fs";

export const LOCAL = "wrangler.local.toml";

function check(name, value, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} looks wrong: "${value}"`);
  return value;
}

export function renderConfig({ host, rootEmail, keep = "0", trash = "30", dbId }) {
  check("APP_HOST", host, /^[a-z0-9.-]+\.[a-z]{2,}$/);
  check("ROOT_EMAIL", rootEmail, /^[^\s"@]+@[^\s"@]+$/);
  check("KEEP_VERSIONS", keep, /^\d+$/);
  check("TRASH_DAYS", trash, /^\d+$/);
  check("D1 database id", dbId, /^[0-9a-f-]{36}$|^<.*>$/);
  const base = readFileSync("wrangler.toml", "utf8")
    .replace(/^APP_HOST = .*$/m, `APP_HOST = "${host}"`)
    .replace(/^ROOT_EMAIL = .*$/m, `ROOT_EMAIL = "${rootEmail}"`)
    .replace(/^KEEP_VERSIONS = .*$/m, `KEEP_VERSIONS = "${keep}"`)
    .replace(/^TRASH_DAYS = .*$/m, `TRASH_DAYS = "${trash}"`)
    .replace(/^# Skips Google sign-in.*\n.*\n/m, "") // comment line + DEV_LOGIN_EMAIL: never in a deployment
    .replace(/^database_id = .*$/m, `database_id = "${dbId}"`)
    .replace(/^# Development defaults[\s\S]*?\n(?=name = )/m, "");
  return `# Generated from wrangler.toml. Not committed: it holds your hostname and account's resource ids.\n${base}
[[routes]]
pattern = "${host}"
custom_domain = true
`;
}
