import type { PairPollResponse, PairStartResponse } from "@artifact/shared";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { ArtifactError } from "../client.ts";
import { loadConfig, originFor, paths, saveConfig, writePrivateFile } from "../profile.ts";

const POLL_MS = 2000;

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The URL is printed as well.
  }
}

export interface LoginOptions {
  host?: string;
  name?: string;
  browser?: boolean;
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
  if (opts.browser !== false) openBrowser(start.approve_url);
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
