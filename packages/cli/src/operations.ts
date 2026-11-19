import {
  MAX_FILE_BYTES,
  contentTypeFor,
  extensionOf,
  invalidPathReason,
  type ArtifactDetail,
  type BlobCheckResponse,
  type ListResponse,
  type PublishResponse,
  type SecretCreateResponse,
  type SecretListResponse,
  type SecretSummary,
  type ProjectListResponse,
  type MoveRequest,
  type MoveResponse,
  MAX_TEXT_CHARS,
  type SearchResponse,
  type CommentListResponse,
  type CommentSummary,
  type CommentRequest,
} from "@artifact/shared";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactError, artifactIdFromUrl, expectOk, session, sha256Hex, signedFetch, signedJson, type Session } from "./client.ts";
import { forgetArtifact, loadState, rememberPublish } from "./profile.ts";
import { detectProject } from "./project.ts";
import { markdownLinks, pageLinks, pageText } from "./text.ts";
import { encryptForLink, encryptForRecipient, fingerprint, readSecretItems, type KeySelection } from "./secret.ts";

export interface PublishInput {
  /** An .html file, or a directory with index.html (every publishable file in it is included). */
  filePath: string;
  /** Extra files as { published path: local path }. Relative local paths resolve from the entry's folder. */
  files?: Record<string, string>;
  title?: string;
  description?: string;
  /** Update this artifact instead of the one remembered for filePath. */
  url?: string;
  allowConnect?: string[];
  /**
   * The project. A new page without it goes into the project named after the git repository
   * this runs in; an update without it keeps the page's project.
   */
  project?: string;
  /** URL (or id) of the page to put this one under; the page goes into that page's project. */
  parent?: string;
}

export interface PublishResult {
  id: string;
  url: string;
  version: number;
  created: boolean;
  files: number;
  uploaded: number;
  project: string | null;
}

interface LocalFile {
  published: string;
  local: string;
  bytes: Buffer;
  sha256: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && contentTypeFor(entry.name)) out.push(full);
  }
  return out;
}

function readLocal(published: string, local: string): LocalFile {
  const reason = invalidPathReason(published);
  if (reason) throw new ArtifactError(`${published}: ${reason}`, "bad_path");
  let size: number;
  try {
    const stat = statSync(local);
    if (!stat.isFile()) throw new ArtifactError(`${local} is not a file.`, "not_found");
    size = stat.size;
  } catch (e) {
    if (e instanceof ArtifactError) throw e;
    throw new ArtifactError(`${local} does not exist.`, "not_found");
  }
  if (size > MAX_FILE_BYTES) {
    throw new ArtifactError(`A file may be at most 25MB; ${published} is ${Math.ceil(size / 1048576)}MB.`, "too_large");
  }
  const bytes = readFileSync(local);
  return { published, local, bytes, sha256: sha256Hex(bytes) };
}

function collectFiles(input: PublishInput): { entry: string; entryLocal: string; files: LocalFile[] } {
  const target = resolve(input.filePath);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new ArtifactError(`${target} does not exist.`, "not_found");
  }
  const files = new Map<string, LocalFile>();
  let entry: string;
  let base: string;
  if (stat.isDirectory()) {
    base = target;
    entry = "index.html";
    for (const local of walk(target)) {
      const published = relative(target, local).split(sep).join("/");
      files.set(published, readLocal(published, local));
    }
    if (!files.has(entry)) throw new ArtifactError(`${target} has no index.html to open first.`, "no_entry");
  } else {
    // An .md file updates a page written in Markdown (one made in the browser).
    if (extensionOf(target) !== "html" && extensionOf(target) !== "md") {
      throw new ArtifactError(`The page must be an .html file; got ${basename(target)}.`, "not_html");
    }
    base = dirname(target);
    entry = basename(target);
    files.set(entry, readLocal(entry, target));
  }
  for (const [published, local] of Object.entries(input.files ?? {})) {
    files.set(published, readLocal(published, resolve(base, local)));
  }
  return { entry, entryLocal: target, files: [...files.values()] };
}

function titleFrom(html: string, fallback: string): string {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html) ?? /^#\s+(.+)$/m.exec(html);
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title || fallback;
}

async function uploadMissing(s: Session, files: LocalFile[]): Promise<number> {
  const unique = new Map(files.map((f) => [f.sha256, f]));
  const { missing } = await signedJson<BlobCheckResponse>(s, "POST", "/api/v1/blobs/check", { hashes: [...unique.keys()] });
  for (const hash of missing) {
    const file = unique.get(hash)!;
    await expectOk(await signedFetch(s, "PUT", `/api/v1/blobs/${hash}`, { body: file.bytes, contentHash: hash }));
  }
  return missing.length;
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const s = session();
  const { entry, entryLocal, files } = collectFiles(input);
  const remembered = loadState().files[entryLocal];
  const targetId = input.url ? artifactIdFromUrl(s, input.url) : remembered?.id;

  let existing: ArtifactDetail | undefined;
  if (targetId) {
    const res = await signedFetch(s, "GET", `/api/v1/artifacts/${targetId}`);
    if (res.status === 404 && !input.url) existing = undefined; // deleted since: publish as new
    else existing = (await (await expectOk(res)).json()) as ArtifactDetail;
  }

  const entryFile = files.find((f) => f.published === entry)!;
  // What the page says and links to, from every HTML file, the entry first.
  const markdown = entry.endsWith(".md");
  const pagesHtml = [entryFile, ...files.filter((f) => f !== entryFile && f.published.endsWith(".html"))].map((f) => f.bytes.toString("utf8"));
  const text = (markdown ? pagesHtml[0]! : pagesHtml.map(pageText).join("\n")).slice(0, MAX_TEXT_CHARS);
  const links = [...new Set(pagesHtml.flatMap((h) => (markdown ? markdownLinks(h, s.origin) : pageLinks(h, s.origin))))].slice(0, 1000);
  const parent = input.parent ? artifactIdFromUrl(s, input.parent) : undefined;
  // Under a parent, the page goes into the parent's project; the repository's name is only a default.
  const project = existing || parent ? input.project : (input.project ?? detectProject());
  const manifest = {
    title: input.title ?? existing?.title ?? titleFrom(entryFile.bytes.toString("utf8"), basename(entryLocal)),
    description: input.description ?? existing?.description ?? undefined,
    entry,
    files: Object.fromEntries(files.map((f) => [f.published, `sha256:${f.sha256}`])),
    allow_connect: input.allowConnect ?? existing?.allow_connect ?? [],
    ...(project ? { project } : {}),
    ...(parent ? { parent } : {}),
    text,
    links,
    // The version this computer last published. If another device has published since, the
    // server answers 409 instead of silently overwriting that work.
    base_version: existing ? (remembered?.id === existing.id ? remembered.version : existing.version) : undefined,
  };

  const uploaded = await uploadMissing(s, files);
  const result = existing
    ? await signedJson<PublishResponse>(s, "PUT", `/api/v1/artifacts/${existing.id}`, manifest)
    : await signedJson<PublishResponse>(s, "POST", "/api/v1/artifacts", manifest);
  rememberPublish(entryLocal, { id: result.id, url: result.url, version: result.version });
  return { ...result, created: !existing, files: files.length, uploaded, project: project ?? existing?.project ?? null };
}

/** `project`: a name for one project, null for pages without one, undefined for all. */
export async function list(limit = 25, project?: string | null): Promise<ListResponse> {
  const filter = project === undefined ? "" : `&project=${encodeURIComponent(project ?? "")}`;
  return signedJson<ListResponse>(session(), "GET", `/api/v1/artifacts?limit=${limit}${filter}`);
}

/** A page's comments, oldest first. */
export async function comments(url: string): Promise<CommentListResponse> {
  const s = session();
  return signedJson<CommentListResponse>(s, "GET", `/api/v1/artifacts/${artifactIdFromUrl(s, url)}/comments`);
}

/** Comments on a page, or replies in a thread (and settles it with resolve). */
export async function comment(url: string, req: CommentRequest): Promise<{ id: string; url: string }> {
  const s = session();
  return signedJson<{ id: string; url: string }>(s, "POST", `/api/v1/artifacts/${artifactIdFromUrl(s, url)}/comments`, req);
}

/** Pages whose title, description or text has every word of `query`. */
export async function search(query: string, limit = 20): Promise<SearchResponse> {
  return signedJson<SearchResponse>(session(), "GET", `/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function projects(): Promise<ProjectListResponse> {
  return signedJson<ProjectListResponse>(session(), "GET", "/api/v1/projects");
}

export interface MoveInput {
  /** Another project (null: none); the pages under it go along. */
  project?: string | null;
  /** URL (or id) of the page to go under, in the same project (null: the top). */
  parent?: string | null;
  /** Its place among its siblings, from 1. */
  position?: number;
}

/** Moves a page in or between projects without making a new version. */
export async function move(url: string, to: MoveInput): Promise<MoveResponse> {
  const s = session();
  const id = artifactIdFromUrl(s, url);
  const body: MoveRequest = { ...to, ...(to.parent ? { parent: artifactIdFromUrl(s, to.parent) } : {}) };
  return signedJson<MoveResponse>(s, "PATCH", `/api/v1/artifacts/${id}`, body);
}

export interface ReadResult {
  detail: ArtifactDetail;
  path: string;
  version: number;
  /** Text content, for text files. */
  text?: string;
  /** Where a binary file was saved. */
  savedTo?: string;
}

const TEXT_TYPES = /^(text\/|application\/json|image\/svg\+xml)/;

export async function read(url: string, path?: string, version?: number): Promise<ReadResult> {
  const s = session();
  const id = artifactIdFromUrl(s, url);
  const detail = await signedJson<ArtifactDetail>(s, "GET", `/api/v1/artifacts/${id}`);
  const v = detail.versions.find((x) => x.version === (version ?? detail.version));
  if (!v) throw new ArtifactError(`Version ${version} does not exist.`, "not_found");
  const filePath = path ?? v.entry;
  const res = await expectOk(
    await signedFetch(s, "GET", `/api/v1/artifacts/${id}/files/${filePath.split("/").map(encodeURIComponent).join("/")}?version=${v.version}`),
  );
  const type = res.headers.get("content-type") ?? "";
  if (TEXT_TYPES.test(type)) return { detail, path: filePath, version: v.version, text: await res.text() };
  const dir = mkdtempSync(join(tmpdir(), "artifact-"));
  const savedTo = join(dir, basename(filePath));
  writeFileSync(savedTo, Buffer.from(await res.arrayBuffer()));
  return { detail, path: filePath, version: v.version, savedTo };
}

export async function remove(url: string): Promise<{ restore: string }> {
  const s = session();
  const id = artifactIdFromUrl(s, url);
  const result = await signedJson<{ restore: string }>(s, "DELETE", `/api/v1/artifacts/${id}`);
  forgetArtifact(id);
  return result;
}

/**
 * A single-use link that creates a view-only browser session as the person who approved this
 * computer, then shows `url` or the list of artifacts.
 */
export async function loginLink(url?: string): Promise<string> {
  const s = session();
  let next = "/";
  if (url) {
    const target = new URL(url, s.origin);
    if (target.host !== new URL(s.origin).host) throw new ArtifactError(`Not a page of ${s.origin}: ${url}`, "bad_url");
    next = target.pathname + target.search;
  }
  const { url: link } = await signedJson<{ url: string }>(s, "POST", "/api/v1/login-links", { next });
  return link;
}

// --- Secret handoff ---

const SECRET_ID = /^[0-9a-z]{16}$/;

function secretId(id: string): string {
  const trimmed = id.trim();
  if (!SECRET_ID.test(trimmed)) {
    throw new ArtifactError(`"${id}" is not a secret request id. Use the id that secret_request returned ("artifact secret status" lists them), not the recipient's link.`, "bad_id");
  }
  return trimmed;
}

export interface SecretState extends SecretSummary {
  /** Computed here from the public key, so a server that swapped the key cannot fake it. */
  fingerprint: string | null;
}

async function withFingerprint(summary: SecretSummary): Promise<SecretState> {
  return { ...summary, fingerprint: summary.public_key ? await fingerprint(summary.public_key) : null };
}

export async function secretRequest(label: string, hours?: number): Promise<SecretCreateResponse> {
  const body: Record<string, unknown> = { label };
  if (hours !== undefined) body["expires_in_hours"] = hours;
  return signedJson<SecretCreateResponse>(session(), "POST", "/api/v1/secrets", body);
}

export interface SecretShareResult extends SecretCreateResponse {
  /** Names only, never values. */
  names: string[];
}

/**
 * Share mode: encrypts the values here under a fresh link secret, stores only the ciphertext, and
 * returns the recipient's link with the link secret after #. The first browser that opens the
 * link and presses Show reads it; no further step is needed.
 */
export async function secretShare(label: string, filePath: string, keys?: KeySelection, hours?: number): Promise<SecretShareResult> {
  const items = readSecretItems(filePath, keys);
  const { linkSecret, envelope } = await encryptForLink({ items });
  const body: Record<string, unknown> = { label, share: envelope };
  if (hours !== undefined) body["expires_in_hours"] = hours;
  const s = session();
  const r = await signedJson<SecretCreateResponse>(s, "POST", "/api/v1/secrets", body);
  if (r.mode !== "share") {
    // A Worker from before share links ignores `share` and makes an ordinary request: undo it.
    await signedJson(s, "DELETE", `/api/v1/secrets/${r.id}`).catch(() => undefined);
    throw new ArtifactError("This deployment does not support share links yet. Update the Worker (pnpm run deploy), then try again.", "unsupported");
  }
  return { ...r, url: `${r.url}#${linkSecret}`, names: items.map((i) => i.name) };
}

export async function secretStatus(id: string): Promise<SecretState> {
  return withFingerprint(await signedJson<SecretSummary>(session(), "GET", `/api/v1/secrets/${secretId(id)}`));
}

export async function secretList(limit = 25): Promise<SecretListResponse> {
  return signedJson<SecretListResponse>(session(), "GET", `/api/v1/secrets?limit=${limit}`);
}

export interface SecretSendResult {
  id: string;
  /** Names only, never values. */
  names: string[];
  fingerprint: string;
}

const NOT_READY: Record<string, string> = {
  waiting: "Nobody has opened the link yet. Send it to the recipient and wait until the status is claimed.",
  sealed: "This request already holds a secret. Delete it and make a new request to send something else.",
  received: "The recipient already received and deleted this request. Make a new request.",
  deleted: "This request was deleted. Make a new request.",
  expired: "This request has expired. Make a new request.",
};

export async function secretSend(id: string, filePath: string, keys?: KeySelection): Promise<SecretSendResult> {
  const s = session();
  const sid = secretId(id);
  const items = readSecretItems(filePath, keys);
  const state = await signedJson<SecretSummary>(s, "GET", `/api/v1/secrets/${sid}`);
  if (state.mode === "share") {
    throw new ArtifactError("This is a share link: its values were put when it was made. Make a new one with secret_share to send something else.", "share_mode");
  }
  if (state.status !== "claimed" || !state.public_key) {
    throw new ArtifactError(NOT_READY[state.status] ?? `The request is ${state.status}.`, `secret_${state.status}`);
  }
  const envelope = await encryptForRecipient(sid, state.public_key, { items });
  await signedJson(s, "PUT", `/api/v1/secrets/${sid}/sealed`, { envelope });
  return { id: sid, names: items.map((i) => i.name), fingerprint: await fingerprint(state.public_key) };
}

export async function secretDelete(id: string): Promise<{ status: string }> {
  return signedJson<{ status: string }>(session(), "DELETE", `/api/v1/secrets/${secretId(id)}`);
}

/** Threads as text: the quote, then each comment with its author; settled threads only with `all`. */
export function formatComments(rows: CommentSummary[], all: boolean): string {
  const firsts = rows.filter((r) => !r.reply_to && (all || !r.resolved));
  return firsts
    .map((f) => {
      const replies = rows.filter((r) => r.reply_to === f.id);
      const line = (r: CommentSummary) => `  ${r.author}${r.by_agent ? " (agent)" : ""}, v${r.version}: ${r.body.replace(/\n/g, "\n    ")}`;
      return [`[${f.id}]${f.resolved ? " (resolved)" : ""}${f.quote ? ` on “${f.quote}”` : " on the page"}`, line(f), ...replies.map(line)].join("\n");
    })
    .join("\n\n");
}
