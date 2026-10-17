import type { PairPollResponse, PairStartResponse } from "@artifact/shared";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { ArtifactError } from "../client.ts";
import { loadConfig, originFor, paths, saveConfig, writePrivateFile } from "../profile.ts";

const POLL_MS = 2000;

/**
 * Short names for `--browser` / ARTIFACT_BROWSER. On Linux each lists candidates in order:
 * a command on PATH, or a Flatpak app (Fedora and others ship browsers as Flatpaks).
 */
const BROWSER_ALIASES: Record<string, { linux?: string[][]; darwin?: string[]; win32?: string[] }> = {
  chrome: {
    linux: [["google-chrome"], ["google-chrome-stable"], ["chromium"], ["chromium-browser"], ["flatpak", "run", "com.google.Chrome"], ["flatpak", "run", "org.chromium.Chromium"]],
    darwin: ["open", "-a", "Google Chrome"],
    win32: ["cmd", "/c", "start", "", "chrome"],
  },
  firefox: {
    linux: [["firefox"], ["flatpak", "run", "org.mozilla.firefox"]],
    darwin: ["open", "-a", "Firefox"],
    win32: ["cmd", "/c", "start", "", "firefox"],
  },
  edge: {
    linux: [["microsoft-edge"], ["microsoft-edge-stable"], ["flatpak", "run", "com.microsoft.Edge"]],
    darwin: ["open", "-a", "Microsoft Edge"],
    win32: ["cmd", "/c", "start", "", "msedge"],
  },
  safari: { darwin: ["open", "-a", "Safari"] },
};

function available(candidate: string[]): boolean {
  const [command, , app] = candidate;
  if (command === "flatpak") return spawnSync("flatpak", ["info", app!], { stdio: "ignore" }).status === 0;
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

/** The command line that opens a URL: the chosen browser, or the system default. */
export function browserCommand(choice: string | undefined): string[] {
  if (choice) {
    const alias = BROWSER_ALIASES[choice.toLowerCase()];
    if (alias && process.platform === "linux" && alias.linux) return alias.linux.find(available) ?? alias.linux[0]!;
    if (alias && process.platform === "darwin" && alias.darwin) return alias.darwin;
    if (alias && process.platform === "win32" && alias.win32) return alias.win32;
    return choice.split(/\s+/); // a command such as "google-chrome" or "flatpak run com.brave.Browser"
  }
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
}

/**
 * Opens the URL in the browser given by `choice`, else ARTIFACT_BROWSER, else BROWSER, else the
 * system default. `choice` may be a short name (chrome, firefox, edge, safari) or a command.
 */
export function openBrowser(url: string, choice?: string): void {
  const [command, ...args] = browserCommand(choice || process.env["ARTIFACT_BROWSER"] || process.env["BROWSER"] || undefined);
  try {
    spawn(command!, [...args, url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The URL is printed as well.
  }
}

export interface LoginOptions {
  host?: string;
  name?: string;
  browser?: boolean;
  /** Which browser to open; see openBrowser. */
  browserChoice?: string;
  log?: (line: string) => void;
}

/**
 * Pairs this computer: makes a new Ed25519 key, asks the server for a code, and waits until
 * the owner approves it in the browser. Only the public key leaves this computer.
 */
export async function login(opts: LoginOptions = {}): Promise<{ deviceId: string; host: string }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const host = (opts.host ?? loadConfig()?.host)?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host) throw new ArtifactError("Which deployment? Run `artifact login --host artifacts.example.com`.", "no_host");
  const origin = originFor(host);
  const name = opts.name ?? hostname();

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "jwk" }).x!;

  let start: PairStartResponse;
  try {
    const res = await fetch(`${origin}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, public_key: rawPublic }),
    });
    const body = (await res.json()) as PairStartResponse & { error?: { message: string } };
    if (!res.ok) throw new ArtifactError(body.error?.message ?? `The server answered ${res.status}.`, "pair_failed");
    start = body;
  } catch (e) {
    if (e instanceof ArtifactError) throw e;
    throw new ArtifactError(`Could not reach ${origin}: ${(e as Error).message}`, "network");
  }

  log(`\nTo let "${name}" publish, open this page and approve it:\n\n  ${start.approve_url}\n`);
  log(`Check that the page shows the same code:  ${start.code}\n`);
  if (opts.browser !== false) openBrowser(start.approve_url, opts.browserChoice);
  log("Waiting for approval…");

  const deadline = Date.parse(start.expires_at);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const poll = (await (await fetch(`${origin}/api/v1/devices/pair/${start.code}`)).json()) as PairPollResponse;
    if (poll.status === "approved") {
      writePrivateFile(paths.key(), privateKey.export({ format: "pem", type: "pkcs8" }).toString());
      saveConfig({ host, device_id: poll.device_id, device_name: name });
      log(`Approved. This computer can now publish to ${origin}.`);
      return { deviceId: poll.device_id, host };
    }
    if (poll.status === "denied") throw new ArtifactError("The login request was denied.", "denied");
    if (poll.status === "expired") break;
  }
  throw new ArtifactError("The login request expired. Run `artifact login` again.", "expired");
}
