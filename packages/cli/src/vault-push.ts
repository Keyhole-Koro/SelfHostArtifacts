import {
  formatVaultTarget,
  leavesPlaintext,
  parseVaultTarget,
  targetIsStale,
  type VaultSecretStatus,
  type VaultStatusResponse,
  type VaultTarget,
  type VaultTargetKind,
  type VaultTargetSpec,
} from "@artifact/shared";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactError, session, signedJson, type Session } from "./client.ts";
import { writePrivateFile } from "./profile.ts";
import { fromUtf8, utf8 } from "./vault-crypto.ts";
import { openSecret, vaultCollections, vaultPut, type PutResult } from "./vault.ts";

/**
 * Delivery (`artifact vault push`): each secret's targets say where its value must go; this
 * device opens the value, hands it to the destination's own tool or API, and records what it
 * delivered. Values go only to a command's standard input, an HTTPS body or a 0600 file, never
 * to an argument, a log or a return value. Design: https://artifacts.keyhole.work/a/cq4gqx5824re9v4c
 */

const secretPath = (collection: string, name: string) => `/api/v1/vault/collections/${encodeURIComponent(collection)}/secrets/${encodeURIComponent(name)}`;

// ---- targets ----

export async function vaultTargets(collection: string, name: string): Promise<VaultTarget[]> {
  const r = await signedJson<{ targets: VaultTarget[] }>(session(), "GET", `${secretPath(collection, name)}/targets`);
  return r.targets;
}

/** Checks the address here first, so the message is immediate, then stores its canonical form. */
export async function vaultTargetAdd(collection: string, name: string, address: string, options: { plaintextOk?: boolean } = {}): Promise<VaultTarget> {
  let spec: VaultTargetSpec;
  try {
    spec = parseVaultTarget(address);
  } catch (e) {
    throw new ArtifactError((e as Error).message, "bad_target");
  }
  if (leavesPlaintext(spec) && !options.plaintextOk) {
    throw new ArtifactError(`${formatVaultTarget(spec)} leaves a plaintext copy on this computer. Add it with --plaintext-ok if that is intended.`, "plaintext_required");
  }
  return signedJson<VaultTarget>(session(), "POST", `${secretPath(collection, name)}/targets`, { address: formatVaultTarget(spec), ...(options.plaintextOk ? { plaintext_ok: true } : {}) });
}

export async function vaultTargetRemove(collection: string, name: string, addressOrId: string): Promise<{ removed: boolean; address: string }> {
  const targets = await vaultTargets(collection, name);
  const wanted = addressOrId.trim();
  let canonical = wanted;
  try {
    canonical = formatVaultTarget(parseVaultTarget(wanted));
  } catch {
    // an id, not an address
  }
  const target = targets.find((t) => t.id === wanted || t.address === canonical);
  if (!target) throw new ArtifactError(`"${addressOrId}" is not a target of ${collection}/${name}. \`artifact vault target list ${collection} ${name}\` shows them.`, "not_found");
  const r = await signedJson<{ removed: boolean }>(session(), "DELETE", `${secretPath(collection, name)}/targets/${target.id}`);
  return { removed: r.removed, address: target.address };
}

// ---- status ----

export async function vaultStatus(collection: string): Promise<VaultStatusResponse> {
  return signedJson<VaultStatusResponse>(session(), "GET", `/api/v1/vault/collections/${encodeURIComponent(collection)}/status`);
}

/** Status of every collection this device can read. */
export async function vaultStatusAll(): Promise<VaultStatusResponse[]> {
  const { collections } = await vaultCollections();
  const out: VaultStatusResponse[] = [];
  for (const c of collections) if (c.readable) out.push(await vaultStatus(c.name));
  return out;
}

export type TargetState = "delivered" | "stale" | "never" | "failed";

/** What `status` shows for one target: delivered at the current version, behind, never delivered, or last try failed. */
export function targetState(target: VaultTarget, currentVersion: number): TargetState {
  if (target.delivered && target.delivered.version >= currentVersion) return "delivered";
  if (target.latest?.result === "failed" && (!target.delivered || target.latest.delivered_at > target.delivered.delivered_at)) return "failed";
  return target.delivered ? "stale" : "never";
}

export function formatStatus(status: VaultStatusResponse): string {
  const lines: string[] = [];
  for (const s of status.secrets) {
    lines.push(`${s.name}  v${s.current_version}  ${s.updated_at.slice(0, 10)}${s.description ? `  ${s.description}` : ""}`);
    if (!s.targets.length) lines.push("  (no delivery targets)");
    for (const t of s.targets) {
      const state = targetState(t, s.current_version);
      const when = t.delivered ? `${t.delivered.delivered_at.slice(0, 16).replace("T", " ")}` : "";
      const word = { delivered: `v${t.delivered?.version} delivered ${when}`, stale: `v${t.delivered?.version} STALE (push v${s.current_version})`, never: `NOT DELIVERED (push v${s.current_version})`, failed: `v${t.latest?.version} FAILED ${t.latest?.delivered_at.slice(0, 16).replace("T", " ") ?? ""}` }[state];
      lines.push(`  ${t.address}  ${word}${t.plaintext_ok ? "  [plaintext]" : ""}`);
    }
  }
  return lines.join("\n") || `${status.collection} has no secrets yet.`;
}

// ---- running the destinations' tools ----

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with the value on its standard input. The value never appears in an argument or in the result. */
function run(bin: string, args: string[], options: { input?: Uint8Array; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => reject(new ArtifactError(`Could not run ${bin}: ${e.message}`, "command_failed")));
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.stdin.on("error", () => undefined);
    if (options.input) child.stdin.end(Buffer.from(options.input));
    else child.stdin.end();
  });
}

const trimmed = (text: string, max = 300) => text.trim().replace(/\s+/g, " ").slice(0, max);

function failed(what: string, r: RunResult): never {
  throw new ArtifactError(`${what} exited with ${r.code}: ${trimmed(r.stderr || r.stdout) || "(no output)"}`, "command_failed");
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface Delivered {
  /** What the destination called it (a version number, an updated_at). Never a value. */
  remoteRef?: string;
  /** The device read the value back and it matched, or the destination confirmed it. */
  verified: boolean;
  note?: string;
}

const gcloudBin = () => process.env["ARTIFACT_GCLOUD"] || "gcloud";

/** The version number in gcloud's "Created version [3] of the secret [name]." */
export function gcloudVersionOf(output: string): string | undefined {
  return /[Cc]reated version \[(\d+)\]/.exec(output)?.[1];
}

export async function deliverGcp(spec: Extract<VaultTargetSpec, { kind: "gcp" }>, value: Uint8Array, verify: boolean): Promise<Delivered> {
  const added = await run(gcloudBin(), ["secrets", "versions", "add", spec.secret, "--project", spec.project, "--data-file=-"], { input: value });
  if (added.code !== 0) failed(`gcloud secrets versions add ${spec.secret}`, added);
  const version = gcloudVersionOf(added.stdout + added.stderr);
  if (!version) return { verified: false, note: `added, but gcloud did not say which version: ${trimmed(added.stdout + added.stderr, 120)}` };
  if (!verify) return { remoteRef: `version ${version}`, verified: false };
  const back = await run(gcloudBin(), ["secrets", "versions", "access", version, "--secret", spec.secret, "--project", spec.project]);
  if (back.code !== 0) return { remoteRef: `version ${version}`, verified: false, note: `could not read version ${version} back: ${trimmed(back.stderr, 120)}` };
  const same = sha256(utf8(back.stdout)) === sha256(value);
  return { remoteRef: `version ${version}`, verified: same, ...(same ? {} : { note: `version ${version} read back differs from what was sent` }) };
}

export async function deliverGithub(spec: Extract<VaultTargetSpec, { kind: "github" }>, value: Uint8Array): Promise<Delivered> {
  const repo = `${spec.owner}/${spec.repo}`;
  const scope = spec.environment ? ["--env", spec.environment] : [];
  const set = await run("gh", ["secret", "set", spec.name, "--repo", repo, ...scope], { input: value });
  if (set.code !== 0) failed(`gh secret set ${spec.name}`, set);
  const list = await run("gh", ["secret", "list", "--repo", repo, ...scope, "--json", "name,updatedAt"]);
  if (list.code !== 0) return { verified: false, note: "set, but the list could not be read" };
  let updatedAt: string | undefined;
  try {
    updatedAt = (JSON.parse(list.stdout) as { name: string; updatedAt: string }[]).find((x) => x.name === spec.name)?.updatedAt;
  } catch {
    // leave undefined
  }
  return { remoteRef: updatedAt ? `updated ${updatedAt}` : undefined, verified: false };
}

export async function deliverWrangler(spec: Extract<VaultTargetSpec, { kind: "wrangler" }>, value: Uint8Array): Promise<Delivered> {
  const where = spec.config ? ["--config", spec.config] : ["--name", spec.worker];
  const put = await run("wrangler", ["secret", "put", spec.name, ...where], { input: value, cwd: spec.cwd ? resolve(spec.cwd) : undefined });
  if (put.code !== 0) failed(`wrangler secret put ${spec.name}`, put);
  const list = await run("wrangler", ["secret", "list", ...where], { cwd: spec.cwd ? resolve(spec.cwd) : undefined });
  let present = false;
  try {
    present = (JSON.parse(list.stdout) as { name: string }[]).some((x) => x.name === spec.name);
  } catch {
    // older output format
  }
  return { remoteRef: "put", verified: present, note: "the Worker was redeployed with the new secret" };
}

const circleciBase = () => (process.env["CIRCLECI_API_BASE"] || "https://circleci.com/api/v2").replace(/\/$/, "");

async function circleci<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${circleciBase()}${path}`, {
      method,
      headers: { "circle-token": token, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ArtifactError(`Could not reach the CircleCI API: ${(e as Error).message}`, "network");
  }
  if (!res.ok) throw new ArtifactError(`CircleCI ${method} ${path.replace(/\/environment-variable\/.*$/, "/environment-variable/…")} answered ${res.status}.`, "command_failed");
  return (await res.json()) as T;
}

async function circleciToken(s: Session, spec: Extract<VaultTargetSpec, { kind: "circleci" }>): Promise<string> {
  if (spec.tokenFrom) return fromUtf8((await openSecret(s, spec.tokenFrom.collection, spec.tokenFrom.name)).value).trim();
  const fromEnv = process.env["CIRCLECI_TOKEN"];
  if (fromEnv) return fromEnv;
  throw new ArtifactError("No CircleCI API token: add ?token=<collection>/<name> to the target (a vault secret that holds a personal API token), or set CIRCLECI_TOKEN.", "no_token");
}

export async function deliverCircleci(s: Session, spec: Extract<VaultTargetSpec, { kind: "circleci" }>, value: Uint8Array): Promise<Delivered> {
  const token = await circleciToken(s, spec);
  const slug = `${spec.vcs}/${spec.org}`;
  let contextId: string | undefined;
  let page: string | undefined;
  do {
    const list = await circleci<{ items: { id: string; name: string }[]; next_page_token: string | null }>(token, "GET", `/context?owner-slug=${encodeURIComponent(slug)}&owner-type=organization${page ? `&page-token=${encodeURIComponent(page)}` : ""}`);
    contextId = list.items.find((c) => c.name === spec.context)?.id;
    page = list.next_page_token ?? undefined;
  } while (!contextId && page);
  if (!contextId) throw new ArtifactError(`CircleCI has no context named "${spec.context}" in ${slug}.`, "not_found");
  await circleci(token, "PUT", `/context/${contextId}/environment-variable/${encodeURIComponent(spec.variable)}`, { value: fromUtf8(value) });
  const vars = await circleci<{ items: { variable: string; updated_at: string }[] }>(token, "GET", `/context/${contextId}/environment-variable`);
  const updated = vars.items.find((v) => v.variable === spec.variable)?.updated_at;
  return { remoteRef: updated ? `updated ${updated}` : undefined, verified: false };
}

/** Writes `KEY=value` into a 0600 env file, replacing the existing line or appending one. */
export function writeEnvLine(path: string, key: string, value: string): { created: boolean } {
  const quoted = /[\s#"'\\]/.test(value) || value === "" ? JSON.stringify(value) : value;
  const line = `${key}=${quoted}`;
  const exists = existsSync(path);
  const text = exists ? readFileSync(path, "utf8") : "";
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const index = lines.findIndex((l) => new RegExp(`^(export\\s+)?${key}\\s*=`).test(l));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  writePrivateFile(path, lines.join("\n") + "\n");
  return { created: !exists };
}

export function deliverEnvfile(spec: Extract<VaultTargetSpec, { kind: "envfile" }>, value: Uint8Array): Delivered {
  const text = fromUtf8(value);
  if (text.includes("\n")) throw new ArtifactError("An env file line cannot hold a value with line breaks; use --out <file> instead.", "bad_value");
  const { created } = writeEnvLine(spec.path, spec.key, text);
  const back = readFileSync(spec.path, "utf8").split(/\r?\n/).some((l) => l === `${spec.key}=${text}` || l === `${spec.key}=${JSON.stringify(text)}`);
  return { remoteRef: `sha256 ${sha256(value).slice(0, 12)}`, verified: back, note: created ? "file created" : undefined };
}

async function deliver(s: Session, spec: VaultTargetSpec, value: Uint8Array, verify: boolean): Promise<Delivered> {
  switch (spec.kind) {
    case "gcp":
      return deliverGcp(spec, value, verify);
    case "github":
      return deliverGithub(spec, value);
    case "circleci":
      return deliverCircleci(s, spec, value);
    case "wrangler":
      return deliverWrangler(spec, value);
    case "envfile":
      return deliverEnvfile(spec, value);
  }
}

// ---- push ----

export interface PushOptions {
  /** One secret; every secret of the collection by default. */
  name?: string;
  /** Show what would be delivered, open nothing. */
  dryRun?: boolean;
  /** Deliver even where the record says the current version arrived. */
  force?: boolean;
  /** Only these kinds. */
  only?: VaultTargetKind[];
  /** Read back where possible (Secret Manager). Default true. */
  verify?: boolean;
}

export type PushAction = "skipped" | "planned" | "delivered" | "failed";

export interface PushItem {
  secret: string;
  version: number;
  target: string;
  kind: VaultTargetKind;
  action: PushAction;
  /** Why it was skipped, or what the destination said. Never a value. */
  detail: string;
}

export interface PushResult {
  collection: string;
  dry_run: boolean;
  items: PushItem[];
  counts: Record<PushAction, number>;
}

function whySkipped(target: VaultTarget, current: number): string {
  return `v${target.delivered?.version} already delivered ${target.delivered?.delivered_at.slice(0, 16).replace("T", " ")}`;
}

export async function vaultPush(collection: string, options: PushOptions = {}): Promise<PushResult> {
  const s = session();
  const status = await vaultStatus(collection);
  const secrets = options.name ? status.secrets.filter((x) => x.name === options.name) : status.secrets;
  if (options.name && !secrets.length) throw new ArtifactError(`"${options.name}" is not in ${status.collection}.`, "not_found");
  const items: PushItem[] = [];
  const verify = options.verify ?? true;
  for (const secret of secrets) {
    let opened: { version: number; value: Uint8Array } | undefined;
    for (const target of secret.targets) {
      if (options.only && !options.only.includes(target.kind)) continue;
      const base = { secret: secret.name, version: secret.current_version, target: target.address, kind: target.kind };
      if (!options.force && !targetIsStale(target, secret.current_version)) {
        items.push({ ...base, action: "skipped", detail: whySkipped(target, secret.current_version) });
        continue;
      }
      if (options.dryRun) {
        items.push({ ...base, action: "planned", detail: target.delivered ? `v${target.delivered.version} → v${secret.current_version}` : "never delivered" });
        continue;
      }
      try {
        opened ??= await openSecret(s, status.collection, secret.name);
        const spec = parseVaultTarget(target.address);
        const result = await deliver(s, spec, opened.value, verify);
        await recordDelivery(s, status.collection, secret.name, target.id, { version: opened.version, result: "delivered", remote_ref: result.remoteRef, verified: result.verified, note: result.note });
        items.push({ ...base, version: opened.version, action: "delivered", detail: [result.remoteRef, result.verified ? "verified" : "", result.note].filter(Boolean).join(", ") || "delivered" });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await recordDelivery(s, status.collection, secret.name, target.id, { version: opened?.version ?? secret.current_version, result: "failed", note: message.slice(0, 500) }).catch(() => undefined);
        items.push({ ...base, action: "failed", detail: message });
      }
    }
    opened = undefined;
  }
  const counts: Record<PushAction, number> = { skipped: 0, planned: 0, delivered: 0, failed: 0 };
  for (const item of items) counts[item.action]++;
  return { collection: status.collection, dry_run: Boolean(options.dryRun), items, counts };
}

async function recordDelivery(s: Session, collection: string, name: string, targetId: string, body: { version: number; result: "delivered" | "failed"; remote_ref?: string | undefined; verified?: boolean | undefined; note?: string | undefined }): Promise<void> {
  const clean: Record<string, unknown> = { version: body.version, result: body.result };
  if (body.remote_ref) clean["remote_ref"] = body.remote_ref;
  if (body.verified) clean["verified"] = true;
  if (body.note) clean["note"] = body.note;
  await signedJson(s, "POST", `${secretPath(collection, name)}/targets/${targetId}/deliveries`, clean);
}

export function formatPush(r: PushResult): string {
  const lines = r.items.map((i) => `${{ skipped: "·", planned: "→", delivered: "✓", failed: "✗" }[i.action]} ${i.secret} v${i.version} → ${i.target}: ${i.detail}`);
  const summary = r.dry_run
    ? `${r.counts.planned} to deliver, ${r.counts.skipped} up to date. Run without --dry-run to deliver.`
    : `${r.counts.delivered} delivered, ${r.counts.failed} failed, ${r.counts.skipped} up to date.`;
  return [...lines, summary].join("\n");
}

// ---- import: bring a value that already lives in Secret Manager into the vault ----

export interface ImportResult extends PutResult {
  target: string;
  remote_ref: string;
}

export async function vaultImport(collection: string, name: string, address: string, ledger: { description?: string; usedBy?: string } = {}): Promise<ImportResult> {
  let spec: VaultTargetSpec;
  try {
    spec = parseVaultTarget(address);
  } catch (e) {
    throw new ArtifactError((e as Error).message, "bad_target");
  }
  if (spec.kind !== "gcp") throw new ArtifactError("Only Secret Manager values can be imported (gcp://…): CircleCI and GitHub do not give values back.", "unsupported");
  const described = await run(gcloudBin(), ["secrets", "versions", "describe", "latest", "--secret", spec.secret, "--project", spec.project, "--format=value(name)"]);
  if (described.code !== 0) failed(`gcloud secrets versions describe ${spec.secret}`, described);
  const remoteVersion = described.stdout.trim().split("/").pop() ?? "latest";
  const accessed = await run(gcloudBin(), ["secrets", "versions", "access", remoteVersion, "--secret", spec.secret, "--project", spec.project]);
  if (accessed.code !== 0) failed(`gcloud secrets versions access ${spec.secret}`, accessed);
  const put = await vaultPut(collection, name, { bytes: utf8(accessed.stdout) }, ledger);
  const target = await vaultTargetAdd(collection, name, formatVaultTarget(spec));
  await recordDelivery(session(), collection, name, target.id, { version: put.version, result: "delivered", remote_ref: `version ${remoteVersion}`, verified: true, note: "imported from this version" });
  return { ...put, target: target.address, remote_ref: `version ${remoteVersion}` };
}

export type { VaultSecretStatus };
