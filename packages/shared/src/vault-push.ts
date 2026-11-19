import { z } from "zod";
import { VAULT_NAME } from "./vault.ts";

/**
 * Delivery (`artifact vault push`): each secret lists where its value must go, as
 * `<kind>://<address>` strings; the device that can open the value delivers it and records what
 * it delivered. The Worker stores targets and delivery records; it never holds a value or a
 * credential for a destination. Design: https://artifacts.keyhole.work/a/cq4gqx5824re9v4c
 *
 *   gcp://<project>/<secret id>                       Secret Manager, a new version via gcloud
 *   circleci://<vcs>/<org>/<context>/<VARIABLE>[?token=<collection>/<name>]
 *   circleci://<organization id>/<context>/<VARIABLE>[?token=…]
 *                                                     a context variable via the v2 API (an org connected through
 *                                                     the GitHub App has no vcs/org slug, only an id)
 *   github://<owner>/<repo>/<NAME>[?environment=<env>] an Actions secret via gh
 *   wrangler://<worker>/<NAME>[?config=<path>&cwd=<dir>] a Worker secret via wrangler
 *   envfile://<absolute path>#<KEY>                   a KEY= line in a 0600 file on this computer
 */
export const VAULT_TARGET_KINDS = ["gcp", "circleci", "github", "wrangler", "envfile"] as const;
export type VaultTargetKind = (typeof VAULT_TARGET_KINDS)[number];

export type VaultTargetSpec =
  | { kind: "gcp"; project: string; secret: string }
  | { kind: "circleci"; owner: { vcs: "gh" | "bb"; org: string } | { id: string }; context: string; variable: string; tokenFrom?: { collection: string; name: string } }
  | { kind: "github"; owner: string; repo: string; name: string; environment?: string }
  | { kind: "wrangler"; worker: string; name: string; config?: string; cwd?: string }
  | { kind: "envfile"; path: string; key: string };

export const MAX_VAULT_TARGET_ADDRESS = 400;

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SECRET_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(address: string, why: string): never {
  throw new Error(`"${address}" is not a delivery target: ${why}`);
}

function params(query: string | undefined, address: string, allowed: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    if (!allowed.includes(key)) fail(address, `unknown option "${key}" (allowed: ${allowed.join(", ") || "none"})`);
    out[key] = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1));
  }
  return out;
}

/** Parses a target address; the message of the thrown Error says what is wrong. */
export function parseVaultTarget(address: string): VaultTargetSpec {
  const trimmed = address.trim();
  if (trimmed.length > MAX_VAULT_TARGET_ADDRESS) fail(address, `longer than ${MAX_VAULT_TARGET_ADDRESS} characters`);
  const m = /^([a-z0-9]+):\/\/([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(trimmed);
  if (!m) fail(address, `write it as <kind>://<address>, with one of ${VAULT_TARGET_KINDS.join(", ")}`);
  const [, kind, path, query, fragment] = m as unknown as [string, string, string, string | undefined, string | undefined];
  const parts = path.split("/");
  switch (kind) {
    case "gcp": {
      const [project, secret, ...rest] = parts;
      if (!project || !secret || rest.length) fail(address, "write gcp://<project>/<secret id>");
      if (!PROJECT.test(project)) fail(address, `"${project}" is not a GCP project id`);
      if (!SECRET_ID.test(secret)) fail(address, `"${secret}" is not a Secret Manager secret id`);
      params(query, address, []);
      return { kind, project, secret };
    }
    case "circleci": {
      // circleci://<gh|bb>/<org>/<context>/<VARIABLE>, or circleci://<organization id>/<context>/<VARIABLE>
      let owner: { vcs: "gh" | "bb"; org: string } | { id: string };
      let context: string | undefined;
      let variable: string | undefined;
      if (parts.length === 3 && UUID.test(parts[0]!)) {
        owner = { id: parts[0]! };
        [, context, variable] = parts;
      } else {
        const [vcs, org, ctx, name, ...rest] = parts;
        if (!vcs || !org || !ctx || !name || rest.length) fail(address, "write circleci://<gh|bb>/<org>/<context>/<VARIABLE>, or circleci://<organization id>/<context>/<VARIABLE>");
        if (vcs !== "gh" && vcs !== "bb") fail(address, `the VCS is gh or bb, not "${vcs}" (an organization connected through the GitHub App is named by its id instead)`);
        if (!SLUG.test(org)) fail(address, "the org uses letters, digits, - _ .");
        owner = { vcs, org };
        context = ctx;
        variable = name;
      }
      if (!context || !SLUG.test(context)) fail(address, "the context name uses letters, digits, - _ .");
      if (!variable || !ENV_NAME.test(variable)) fail(address, `"${variable ?? ""}" is not a variable name`);
      const options = params(query, address, ["token"]);
      let tokenFrom: { collection: string; name: string } | undefined;
      if (options["token"] !== undefined) {
        const [collection, name, ...more] = options["token"].split("/");
        if (!collection || !name || more.length || !VAULT_NAME.test(collection) || !VAULT_NAME.test(name)) fail(address, "token=<collection>/<name> names a vault secret that holds the CircleCI API token");
        tokenFrom = { collection, name };
      }
      return { kind, owner, context, variable, ...(tokenFrom ? { tokenFrom } : {}) };
    }
    case "github": {
      const [owner, repo, name, ...rest] = parts;
      if (!owner || !repo || !name || rest.length) fail(address, "write github://<owner>/<repo>/<NAME>[?environment=<env>]");
      if (!SLUG.test(owner) || !SLUG.test(repo)) fail(address, "owner and repo use letters, digits, - _ .");
      if (!ENV_NAME.test(name) || /^GITHUB_/i.test(name)) fail(address, `"${name}" is not an Actions secret name`);
      const options = params(query, address, ["environment"]);
      const environment = options["environment"];
      if (environment !== undefined && !/^[A-Za-z0-9_. -]{1,100}$/.test(environment)) fail(address, "the environment name is 1 to 100 letters, digits, - _ . or spaces");
      return { kind, owner, repo, name, ...(environment ? { environment } : {}) };
    }
    case "wrangler": {
      const [worker, name, ...rest] = parts;
      if (!worker || !name || rest.length) fail(address, "write wrangler://<worker>/<NAME>[?config=<path>&cwd=<dir>]");
      if (!WORKER.test(worker)) fail(address, `"${worker}" is not a Worker name`);
      if (!ENV_NAME.test(name)) fail(address, `"${name}" is not a secret name`);
      const options = params(query, address, ["config", "cwd"]);
      return { kind, worker, name, ...(options["config"] ? { config: options["config"] } : {}), ...(options["cwd"] ? { cwd: options["cwd"] } : {}) };
    }
    case "envfile": {
      if (!path.startsWith("/")) fail(address, "write envfile:///absolute/path/.env#KEY");
      if (!fragment || !ENV_NAME.test(fragment)) fail(address, "put the variable name after #, e.g. envfile:///home/me/app/.env.local#API_KEY");
      params(query, address, []);
      return { kind, path, key: fragment };
    }
    default:
      return fail(address, `unknown kind "${kind}" (use ${VAULT_TARGET_KINDS.join(", ")})`);
  }
}

/** The canonical string of a parsed target, as stored and shown. */
export function formatVaultTarget(spec: VaultTargetSpec): string {
  switch (spec.kind) {
    case "gcp":
      return `gcp://${spec.project}/${spec.secret}`;
    case "circleci":
      return `circleci://${"id" in spec.owner ? spec.owner.id : `${spec.owner.vcs}/${spec.owner.org}`}/${spec.context}/${spec.variable}${spec.tokenFrom ? `?token=${spec.tokenFrom.collection}/${spec.tokenFrom.name}` : ""}`;
    case "github":
      return `github://${spec.owner}/${spec.repo}/${spec.name}${spec.environment ? `?environment=${encodeURIComponent(spec.environment)}` : ""}`;
    case "wrangler": {
      const q = [spec.config ? `config=${encodeURIComponent(spec.config)}` : "", spec.cwd ? `cwd=${encodeURIComponent(spec.cwd)}` : ""].filter(Boolean).join("&");
      return `wrangler://${spec.worker}/${spec.name}${q ? `?${q}` : ""}`;
    }
    case "envfile":
      return `envfile://${spec.path}#${spec.key}`;
  }
}

/** True for the one kind that leaves a plaintext copy behind (a file on the device). */
export function leavesPlaintext(spec: VaultTargetSpec): boolean {
  return spec.kind === "envfile";
}

// ---- API ----

/** POST /api/v1/vault/collections/:name/secrets/:secret/targets */
export const vaultTargetCreateSchema = z.object({
  address: z.string().trim().min(1).max(MAX_VAULT_TARGET_ADDRESS),
  /** Required for envfile targets: the person accepted that a plaintext copy stays on the device. */
  plaintext_ok: z.boolean().optional(),
});

/** POST /api/v1/vault/collections/:name/secrets/:secret/targets/:id/deliveries */
export const vaultDeliveryCreateSchema = z.object({
  version: z.number().int().min(1),
  result: z.enum(["delivered", "failed"]),
  /** What the destination called it: a Secret Manager version number, an updated_at, … Never a value. */
  remote_ref: z.string().trim().max(200).optional(),
  /** The device read the value back (or the destination confirmed it) and it matched. */
  verified: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

export interface VaultDelivery {
  id: string;
  version: number;
  result: "delivered" | "failed";
  remote_ref: string | null;
  verified_at: string | null;
  delivered_at: string;
  delivered_by: string;
  note: string | null;
}

export interface VaultTarget {
  id: string;
  kind: VaultTargetKind;
  address: string;
  plaintext_ok: boolean;
  added_by: string;
  added_at: string;
  removed_at: string | null;
  /** The newest delivery record, delivered or failed. */
  latest: VaultDelivery | null;
  /** The newest successful delivery. */
  delivered: VaultDelivery | null;
}

/** One secret with its targets, for `vault status` and `vault push`. */
export interface VaultSecretStatus {
  name: string;
  description: string | null;
  used_by: string | null;
  current_version: number;
  updated_at: string;
  targets: VaultTarget[];
}

export interface VaultStatusResponse {
  collection: string;
  key_version: number;
  secrets: VaultSecretStatus[];
}

/** Whether a target needs a delivery: nothing delivered yet, or an older version than the current one. */
export function targetIsStale(target: VaultTarget, currentVersion: number): boolean {
  return !target.delivered || target.delivered.version < currentVersion;
}
