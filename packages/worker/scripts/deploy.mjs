#!/usr/bin/env node
// Interactive first deployment (and safe to re-run): creates D1 and R2 if missing, writes
// wrangler.local.toml, applies migrations, deploys, and sets the secrets that are not set yet.
//
//   pnpm run deploy                from packages/worker
//   pnpm run deploy --owner-link   also print a new one-time owner link (e.g. after losing your passkeys)
//   pnpm run deploy --dry-run      only print the wrangler.local.toml it would write

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { LOCAL, renderConfig } from "./config.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const OWNER_LINK = process.argv.includes("--owner-link");
const OWNER_LINK_DAYS = 1;
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
  return { host: get("APP_HOST"), keep: get("KEEP_VERSIONS"), trash: get("TRASH_DAYS"), dbId: get("database_id") };
}

/**
 * A one-time owner invite, written straight into D1 (only its hash). Made when the deployment has
 * no owner yet, or on --owner-link to recover access. Whoever opens it first becomes an owner.
 */
function ownerInvite(host) {
  const count = JSON.parse(
    wrangler(["d1", "execute", DB_NAME, "--remote", "-c", LOCAL, "--json", "--command", "select count(*) as n from users where role = 'root'"]),
  )[0].results[0].n;
  if (count > 0 && !OWNER_LINK) return undefined;
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + OWNER_LINK_DAYS * 864e5).toISOString();
  wrangler([
    "d1", "execute", DB_NAME, "--remote", "-c", LOCAL, "--command",
    `insert into invites (token_hash, role, created_by, expires_at) values ('${hash}', 'root', null, '${expires}')`,
  ]);
  return `https://${host}/invite/${token}`;
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

  const toml = renderConfig({ host, keep, trash, dbId });
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
  for (const name of ["SESSION_SECRET", "CONTENT_TOKEN_SECRET"]) {
    if (!existingSecrets.includes(name)) secrets[name] = randomBytes(32).toString("base64url");
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

  const ownerLink = ownerInvite(host);
  if (ownerLink) {
    console.log(`
Open this link to create the owner's passkey (works once, for ${OWNER_LINK_DAYS} day):

  ${ownerLink}
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
