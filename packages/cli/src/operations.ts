import {
  MAX_FILE_BYTES,
  contentTypeFor,
  extensionOf,
  invalidPathReason,
  type ArtifactDetail,
  type BlobCheckResponse,
  type ListResponse,
  type PublishResponse,
} from "@artifact/shared";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ArtifactError, artifactIdFromUrl, expectOk, session, sha256Hex, signedFetch, signedJson, type Session } from "./client.ts";
import { forgetArtifact, loadState, rememberPublish } from "./profile.ts";

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
}

export interface PublishResult {
  id: string;
  url: string;
  version: number;
  created: boolean;
  files: number;
  uploaded: number;
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
    if (extensionOf(target) !== "html") throw new ArtifactError(`The page must be an .html file; got ${basename(target)}.`, "not_html");
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
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
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
  const manifest = {
    title: input.title ?? existing?.title ?? titleFrom(entryFile.bytes.toString("utf8"), basename(entryLocal)),
    description: input.description ?? existing?.description ?? undefined,
    entry,
    files: Object.fromEntries(files.map((f) => [f.published, `sha256:${f.sha256}`])),
    allow_connect: input.allowConnect ?? existing?.allow_connect ?? [],
    // The version this computer last published. If another device has published since, the
    // server answers 409 instead of silently overwriting that work.
    base_version: existing ? (remembered?.id === existing.id ? remembered.version : existing.version) : undefined,
  };

  const uploaded = await uploadMissing(s, files);
  const result = existing
    ? await signedJson<PublishResponse>(s, "PUT", `/api/v1/artifacts/${existing.id}`, manifest)
    : await signedJson<PublishResponse>(s, "POST", "/api/v1/artifacts", manifest);
  rememberPublish(entryLocal, { id: result.id, url: result.url, version: result.version });
  return { ...result, created: !existing, files: files.length, uploaded };
}

export async function list(limit = 25): Promise<ListResponse> {
  return signedJson<ListResponse>(session(), "GET", `/api/v1/artifacts?limit=${limit}`);
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
