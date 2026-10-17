#!/usr/bin/env node
// Retakes the README screenshots (docs/images/*.png) from a throwaway local deployment:
// a fresh D1/R2 under a temp dir, sample people, a paired sample device, the pages in
// examples/ published through the real CLI, and Playwright for the pictures.
//
//   pnpm screenshots            all shots
//   pnpm screenshots list viewer   only these
//
// First run: npx playwright install chromium

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const WORKER = join(ROOT, "packages/worker");
const CLI = join(ROOT, "packages/cli/src/cli.ts");
const OUT = join(ROOT, "docs/images");

/** The README screenshots. `page` is "list", "settings", or the key of a sample in SAMPLES. */
const SHOTS = [
  { name: "viewer", page: "cost", viewport: { width: 1280, height: 860 } },
  { name: "list", page: "list", viewport: { width: 1280, height: 520 } },
  { name: "phone-dark", page: "cost", viewport: { width: 390, height: 844 }, dark: true, mobile: true },
  { name: "settings", page: "settings", viewport: { width: 1280, height: 820 } },
  { name: "tool-dark", page: "contrast", viewport: { width: 1280, height: 760 }, dark: true, tab: "Dark" },
];

/** Published oldest first, so the list shows them newest first. */
const SAMPLES = [
  { key: "sign-in", dir: "examples/sign-in-explained", description: "Passkeys, invite links, QR codes and artifact open, and what the server stores" },
  { key: "contrast", dir: "examples/contrast-checker", description: "Checks every text colour of the design guide against its backgrounds" },
  { key: "cost", dir: "examples/cost-estimate", description: "What it costs on Cloudflare's free tiers, and when you would pay", versions: 2 },
];

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

/** People shown in Settings. Passkey rows are placeholders: nobody signs in with them here. */
const SEED_SQL = `
insert into users (id, name, role, created_at) values
  ('owner0000000000000000', 'Alex Kim', 'root', '${daysAgo(20)}'),
  ('viewer000000000000000', 'Sam Lee', 'viewer', '${daysAgo(6)}');
insert into passkeys (id, user_id, public_key, counter, label, created_at) values
  ('sample-a', 'owner0000000000000000', 'x', 0, 'Mac · Safari', '${daysAgo(20)}'),
  ('sample-b', 'owner0000000000000000', 'x', 0, 'iPhone / iPad', '${daysAgo(19)}'),
  ('sample-c', 'viewer000000000000000', 'x', 0, 'Android · Chrome', '${daysAgo(6)}');
insert into sessions (id, user_id, csrf, expires_at) values ('screenshots', 'owner0000000000000000', 'screenshots', '2999-01-01');
`;

function freePort() {
  return new Promise((ok) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });
}

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function artifact(args, env) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
}

async function waitFor(url, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  if (shots.length === 0) throw new Error(`No such shot. Pick from: ${SHOTS.map((s) => s.name).join(", ")}`);

  const work = mkdtempSync(join(tmpdir(), "artifact-shots-"));
  const state = join(work, "state");
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const cliEnv = { XDG_CONFIG_HOME: join(work, "config"), ARTIFACT_BROWSER: "none", ARTIFACT_PROFILE: "screenshots" };
  let dev;

  try {
    console.log("Preparing a throwaway database…");
    wrangler(["d1", "migrations", "apply", "artifacts", "--local", "--persist-to", state]);
    wrangler(["d1", "execute", "artifacts", "--local", "--persist-to", state, "--command", SEED_SQL]);

    console.log(`Starting the Worker on ${origin}…`);
    dev = spawn(
      "npx",
      ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--var", `APP_HOST:localhost:${port}`, "--var", "DEV_LOGIN:true"],
      { cwd: WORKER, stdio: "ignore", detached: true },
    );
    await waitFor(`${origin}/health`);

    console.log("Pairing a sample device…");
    const login = spawn(process.execPath, [CLI, "login", "--host", `localhost:${port}`, "--name", "work-laptop"], {
      cwd: ROOT,
      env: { ...process.env, ...cliEnv },
    });
    let output = "";
    login.stdout.on("data", (d) => (output += d));
    const code = await new Promise((ok, fail) => {
      const timer = setInterval(() => {
        const m = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output);
        if (m) {
          clearInterval(timer);
          ok(m[1]);
        }
      }, 100);
      setTimeout(() => fail(new Error(`artifact login printed no code:\n${output}`)), 20000);
    });
    const approve = await fetch(`${origin}/pair/${code}`, {
      method: "POST",
      headers: { cookie: "__Host-artifact_session=screenshots", origin, "content-type": "application/x-www-form-urlencoded" },
      body: "csrf=screenshots&decision=approve",
    });
    if (!approve.ok) throw new Error(`Approving the device failed: ${approve.status}`);
    await new Promise((ok) => login.on("exit", ok));

    console.log("Publishing the samples…");
    const urls = {};
    for (const sample of SAMPLES) {
      const result = JSON.parse(artifact(["publish", sample.dir, "--description", sample.description, "--json"], cliEnv));
      for (let v = 1; v < (sample.versions ?? 1); v++) artifact(["publish", sample.dir], cliEnv);
      urls[sample.key] = new URL(result.url).pathname;
    }

    console.log("Taking screenshots…");
    const browser = await chromium.launch();
    for (const shot of shots) {
      const path = shot.page === "list" ? "/" : shot.page === "settings" ? "/settings" : urls[shot.page];
      const context = await browser.newContext({
        viewport: shot.viewport,
        deviceScaleFactor: 2,
        colorScheme: shot.dark ? "dark" : "light",
        isMobile: !!shot.mobile,
        hasTouch: !!shot.mobile,
      });
      const page = await context.newPage();
      await page.goto(`${origin}/auth/login?next=${encodeURIComponent(path)}`);
      await page.waitForLoadState("networkidle");
      if (path.startsWith("/a/")) await page.frameLocator("#frame").locator("h1").waitFor();
      if (shot.tab) await page.frameLocator("#frame").getByRole("tab", { name: shot.tab }).click();
      await page.waitForTimeout(700); // charts and fonts settle
      await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
      await context.close();
      console.log(`  docs/images/${shot.name}.png`);
    }
    await browser.close();
  } finally {
    if (dev) {
      try {
        process.kill(-dev.pid);
      } catch {
        // already gone
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
