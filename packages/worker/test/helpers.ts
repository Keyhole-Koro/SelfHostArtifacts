import { CONTENT_HASH_HEADER, canonicalRequest, formatSignatureHeader, type Manifest } from "@article/shared";
import { SELF, env } from "cloudflare:test";
import { base64url, randomId, randomToken, sha256Hex, utf8 } from "../src/lib/encoding.ts";

export const ORIGIN = "http://localhost:8787";
export const ROOT = "root@example.com";

export interface TestDevice {
  id: string;
  privateKey: CryptoKey;
}

export async function createDevice(name = "test-laptop"): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const id = randomId();
  await env.DB.prepare("insert into devices (id, name, public_key, created_at) values (?, ?, ?, ?)")
    .bind(id, name, base64url(raw), new Date().toISOString())
    .run();
  return { id, privateKey: pair.privateKey };
}

export interface SignOptions {
  body?: Uint8Array<ArrayBuffer> | string;
  /** Hash to declare; defaults to the body's hash. */
  contentHash?: string;
  ts?: number;
  nonce?: string;
  headers?: Record<string, string>;
}

export async function signedRequest(device: TestDevice, method: string, path: string, opts: SignOptions = {}): Promise<Request> {
  const body = typeof opts.body === "string" ? utf8(opts.body) : opts.body;
  const contentHash = opts.contentHash ?? (await sha256Hex(body ?? new Uint8Array()));
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomToken();
  const message = canonicalRequest(method, path, ts, nonce, contentHash);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", device.privateKey, utf8(message)));
  const headers = new Headers(opts.headers);
  headers.set("authorization", formatSignatureHeader({ key: device.id, ts, nonce, sig: base64url(sig) }));
  headers.set(CONTENT_HASH_HEADER, contentHash);
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

export async function signedFetch(device: TestDevice, method: string, path: string, opts: SignOptions = {}): Promise<Response> {
  return SELF.fetch(await signedRequest(device, method, path, opts));
}

export async function signedJson(device: TestDevice, method: string, path: string, json: unknown): Promise<Response> {
  return signedFetch(device, method, path, { body: JSON.stringify(json) });
}

export async function uploadBlob(device: TestDevice, text: string): Promise<string> {
  const bytes = utf8(text);
  const hash = await sha256Hex(bytes);
  const res = await signedFetch(device, "PUT", `/api/v1/blobs/${hash}`, {
    body: bytes,
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
  });
  if (res.status !== 201 && res.status !== 204) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return hash;
}

/** Uploads the files and publishes them; returns the API response body. */
export async function publish(
  device: TestDevice,
  files: Record<string, string>,
  extra: Partial<Manifest> & { id?: string } = {},
): Promise<{ status: number; body: any }> {
  const refs: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) refs[path] = `sha256:${await uploadBlob(device, text)}`;
  const { id, ...rest } = extra;
  const manifest = { title: "Test page", entry: "index.html", files: refs, ...rest };
  const res = await signedJson(device, id ? "PUT" : "POST", id ? `/api/v1/artifacts/${id}` : "/api/v1/artifacts", manifest);
  return { status: res.status, body: await res.json() };
}

/** A signed-in browser session for `email`, as a Cookie header value. */
export async function sessionCookie(email: string): Promise<{ cookie: string; csrf: string }> {
  const id = randomToken();
  const csrf = randomToken();
  await env.DB.prepare("insert into sessions (id, email, csrf, expires_at) values (?, ?, ?, ?)")
    .bind(id, email, csrf, new Date(Date.now() + 864e5).toISOString())
    .run();
  return { cookie: `__Host-article_session=${id}`, csrf };
}

export function browserGet(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
}

export function browserPost(path: string, cookie: string, form: Record<string, string>, origin: string | null = ORIGIN): Promise<Response> {
  const headers: Record<string, string> = { cookie, "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers["origin"] = origin;
  return SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers, body: new URLSearchParams(form).toString(), redirect: "manual" });
}

/** The /c/... URL of the viewer page's iframe. */
export async function contentSrc(id: string, cookie: string, version?: number): Promise<string> {
  const res = await browserGet(`/a/${id}/token${version ? `?v=${version}` : ""}`, cookie);
  const body = (await res.json()) as { src: string };
  return body.src;
}
