#!/usr/bin/env node
// Writes wrangler.local.toml from environment variables, for CI:
//   APP_HOST, D1_DATABASE_ID, and optionally ROOT_EMAIL (Google sign-in), KEEP_VERSIONS, TRASH_DAYS
import { writeFileSync } from "node:fs";
import { LOCAL, renderConfig } from "./config.mjs";

const env = process.env;
for (const name of ["APP_HOST", "D1_DATABASE_ID"]) {
  if (!env[name]) {
    console.error(`${name} is not set. Add it in Settings → Secrets and variables → Actions (see .github/workflows/deploy-worker.yml).`);
    process.exit(1);
  }
}
writeFileSync(
  LOCAL,
  renderConfig({
    host: env.APP_HOST,
    rootEmail: env.ROOT_EMAIL || undefined,
    keep: env.KEEP_VERSIONS || "0",
    trash: env.TRASH_DAYS || "30",
    dbId: env.D1_DATABASE_ID,
  }),
);
console.log(`Wrote ${LOCAL} for ${env.APP_HOST}`);
