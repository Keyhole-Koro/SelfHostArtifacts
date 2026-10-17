import { CONTENT_HASH_HEADER, canonicalRequest, formatSignatureHeader } from "@artifact/shared";
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, originFor, paths, type ProfileConfig } from "./profile.ts";

/** An error whose message is meant for the agent (or person) as is. */
export class ArtifactError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, code = "error", details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface Session {
  config: Required<Pick<ProfileConfig, "host" | "device_id">> & ProfileConfig;
  origin: string;
  key: KeyObject;
}

export function session(): Session {
  const config = loadConfig();
  if (!config?.device_id || !existsSync(paths.key())) {
    throw new ArtifactError("Not logged in. Ask the user to run `artifact login` (or `artifact setup`) in a terminal.", "not_logged_in");
  }
  return {
    config: config as Session["config"],
    origin: originFor(config.host),
    key: createPrivateKey(readFileSync(paths.key())),
  };
}

export interface RequestOptions {
  json?: unknown;
  body?: Uint8Array;
  /** Declared body hash; for blob uploads it is the blob's own hash. */
  contentHash?: string;
}

export async function signedFetch(s: Session, method: string, pathWithQuery: string, opts: RequestOptions = {}): Promise<Response> {
  const body = opts.json !== undefined ? new TextEncoder().encode(JSON.stringify(opts.json)) : opts.body;
  const contentHash = opts.contentHash ?? sha256Hex(body ?? new Uint8Array());
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const sig = sign(null, Buffer.from(canonicalRequest(method, pathWithQuery, ts, nonce, contentHash)), s.key).toString("base64url");
  const headers: Record<string, string> = {
    authorization: formatSignatureHeader({ key: s.config.device_id, ts, nonce, sig }),
    [CONTENT_HASH_HEADER]: contentHash,
  };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  else if (body) headers["content-type"] = "application/octet-stream";
  let res: Response;
  try {
    res = await fetch(`${s.origin}${pathWithQuery}`, { method, headers, body });
  } catch (e) {
    throw new ArtifactError(`Could not reach ${s.origin}: ${(e as Error).message}`, "network");
  }
  return res;
}

/** Throws the server's error message when the response is not OK. */
export async function expectOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let body: { error?: { code?: string; message?: string } } & Record<string, unknown> = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON
  }
  const message = body.error?.message ?? `The server answered ${res.status} ${res.statusText}.`;
  throw new ArtifactError(message, body.error?.code ?? `http_${res.status}`, body);
}

export async function signedJson<T>(s: Session, method: string, path: string, json?: unknown): Promise<T> {
  const res = await expectOk(await signedFetch(s, method, path, json === undefined ? {} : { json }));
  return (await res.json()) as T;
}

/** The artifact id in an artifact URL (…/a/<id>), checked against this profile's host. */
export function artifactIdFromUrl(s: Session, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    if (/^[0-9a-z]{16}$/.test(url)) return url;
    throw new ArtifactError(`Not an artifact URL: ${url}`, "bad_url");
  }
  const match = /^\/a\/([0-9a-z]{16})(?:\/|$)/.exec(parsed.pathname);
  if (!match || parsed.host !== new URL(s.origin).host) {
    throw new ArtifactError(`Not an artifact URL of ${s.origin}: ${url}`, "bad_url");
  }
  return match[1]!;
}
