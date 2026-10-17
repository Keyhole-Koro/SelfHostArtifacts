#!/usr/bin/env node
// Interactive first deployment (and safe to re-run): creates D1 and R2 if missing, writes
// wrangler.local.toml, applies migrations, deploys, and sets the secrets that are not set yet.
//
//   pnpm run deploy            from packages/worker
//   pnpm run deploy --dry-run  only print the wrangler.local.toml it would write

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const DRY_RUN = process.argv.includes("--dry-run");
const LOCAL = "wrangler.local.toml";
const DB_NAME = "artifacts";
const BUCKET = "artifacts-blobs";

const rl = createInterface({ input: process.stdin, terminal: false });
// Reading from the iterator keeps lines that arrive before the question (piped input).
const lines = rl[Symbol.asyncIterator]();

async function ask(question, fallback) {
  process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
  const { value, done } = await lines.next();
  if (done && !fallback) throw new Error(`No answer for "${question}".`);
  return (value ?? "").trim() || fallback || "";
}

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe", input: opts.input });
}

function previous() {
  if (!existsSync(LOCAL)) return {};
  const text = readFileSync(LOCAL, "utf8");
  const get = (key) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(text)?.[1];
  return { host: get("APP_HOST"), rootEmail: get("ROOT_EMAIL"), keep: get("KEEP_VERSIONS"), trash: get("TRASH_DAYS"), dbId: get("database_id") };
}

function localToml({ host, rootEmail, keep, trash, dbId }) {
  const base = readFileSync("wrangler.toml", "utf8")
    .replace(/^APP_HOST = .*$/m, `APP_HOST = "${host}"`)
    .replace(/^ROOT_EMAIL = .*$/m, `ROOT_EMAIL = "${rootEmail}"`)
    .replace(/^KEEP_VERSIONS = .*$/m, `KEEP_VERSIONS = "${keep}"`)
    .replace(/^TRASH_DAYS = .*$/m, `TRASH_DAYS = "${trash}"`)
    .replace(/^# Skips Google sign-in.*\n.*\n/m, "") // comment line + DEV_LOGIN_EMAIL: never in a deployment
    .replace(/^database_id = .*$/m, `database_id = "${dbId}"`)
    .replace(/^# Development defaults[\s\S]*?\n(?=name = )/m, "");
  return `# Written by scripts/deploy.mjs. Not committed: it holds your hostname and account's resource ids.\n${base}
[[routes]]
pattern = "${host}"
custom_domain = true
`;
}

async function main() {
  const prev = previous();
  console.log("Deploy artifact to your Cloudflare account.\n");

  if (!DRY_RUN) {
    try {
      console.log(wrangler(["whoami"]).split("\n").find((l) => l.includes("associated with")) ?? "Logged in to Cloudflare.");
    } catch {
      console.error("Log in first: npx wrangler login");
      process.exit(1);
    }
  }

  const host = (await ask("Hostname (a subdomain of a zone on this account)", prev.host)).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error(`Not a hostname: ${host}`);
  const rootEmail = (await ask("Owner's Google account (ROOT_EMAIL)", prev.rootEmail)).toLowerCase();
  if (!rootEmail.includes("@")) throw new Error(`Not an email address: ${rootEmail}`);
  const keep = await ask("Versions to keep per artifact (0 = all)", prev.keep ?? "0");
  const trash = await ask("Days before the trash is emptied", prev.trash ?? "30");

  let dbId = prev.dbId && !/^0{8}-/.test(prev.dbId) ? prev.dbId : undefined;
  if (DRY_RUN) dbId ??= "<created on deploy>";
  if (!dbId) {
    const existing = JSON.parse(wrangler(["d1", "list", "--json"])).find((d) => d.name === DB_NAME);
    if (existing) dbId = existing.uuid;
    else {
      const out = wrangler(["d1", "create", DB_NAME]);
      dbId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(out)?.[0];
      if (!dbId) throw new Error(`Could not read the database id from:\n${out}`);
    }
    console.log(`D1 database ${DB_NAME}: ${dbId}`);
  }

  const toml = localToml({ host, rootEmail, keep, trash, dbId });
  if (DRY_RUN) {
    console.log(`\n--- ${LOCAL} ---\n${toml}`);
    return;
  }
  writeFileSync(LOCAL, toml);

  if (!wrangler(["r2", "bucket", "list"]).includes(BUCKET)) {
    wrangler(["r2", "bucket", "create", BUCKET], { inherit: true });
  }

  wrangler(["d1", "migrations", "apply", DB_NAME, "--remote", "-c", LOCAL], { inherit: true });
  wrangler(["deploy", "-c", LOCAL], { inherit: true });

  let existingSecrets = [];
  try {
    existingSecrets = JSON.parse(wrangler(["secret", "list", "-c", LOCAL, "--format", "json"])).map((s) => s.name);
  } catch {
    // first deployment
  }
  const secrets = {};
  let googleLater = false;
  for (const name of ["SESSION_SECRET", "CONTENT_TOKEN_SECRET"]) {
    if (!existingSecrets.includes(name)) secrets[name] = randomBytes(32).toString("base64url");
  }
  if (!existingSecrets.includes("GOOGLE_CLIENT_ID")) {
    console.log(`
Google sign-in needs an OAuth client (Google Cloud console → APIs & Services → Credentials →
Create credentials → OAuth client ID → Web application) with this authorized redirect URI:

  https://${host}/auth/callback
`);
    if (process.stdin.isTTY) {
      secrets.GOOGLE_CLIENT_ID = await ask("Client ID");
      secrets.GOOGLE_CLIENT_SECRET = await ask("Client secret");
    } else {
      // Not a terminal (e.g. run by an agent): keep the client secret out of its transcript.
      googleLater = true;
    }
  }
  if (Object.keys(secrets).length) {
    const file = join(tmpdir(), `artifact-secrets-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    try {
      wrangler(["secret", "bulk", file, "-c", LOCAL], { inherit: true });
    } finally {
      rmSync(file, { force: true });
    }
  }

  if (googleLater) {
    console.log(`
Google sign-in is not configured yet. In your own terminal, from packages/worker, run:

  npx wrangler secret put GOOGLE_CLIENT_ID -c ${LOCAL}
  npx wrangler secret put GOOGLE_CLIENT_SECRET -c ${LOCAL}
`);
  }

  console.log(`
Deployed: https://${host}

Next, on each computer whose agents should publish:

  npm i -g @keyhole-koro/artifacts
  artifact setup --host ${host}
`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
