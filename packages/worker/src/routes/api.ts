import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_VERSION,
  MAX_VERSION_BYTES,
  SHA256_HEX,
  contentTypeFor,
  hashOf,
  manifestSchema,
  type ArtifactDetail,
  type ArtifactSummary,
  type BlobCheckResponse,
  type ListResponse,
  type Manifest,
  type PairPollResponse,
  type PairStartResponse,
  type PublishResponse,
  type VersionFile,
} from "@artifact/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.ts";
import { requireDevice } from "../auth/device.ts";
import {
  addVersion,
  createArtifact,
  getArtifact,
  getVersion,
  listArtifacts,
  listVersions,
  trashArtifact,
  type ArtifactRow,
} from "../db/artifacts.ts";
import { createLoginLink, createUser, firstRoot, getUser, LOGIN_LINK_SECONDS } from "../db/users.ts";
import { apiError } from "../lib/api-error.ts";
import { pairingCode, randomId } from "../lib/encoding.ts";

export const blobKey = (sha256: string) => `blobs/${sha256}`;

const PAIRING_MINUTES = 10;
const MAX_PENDING_PAIRINGS = 10;

export const api = new Hono<AppEnv>();

function artifactUrl(c: Context<AppEnv>, id: string): string {
  return `${c.get("config").origin}/a/${id}`;
}

function summary(c: Context<AppEnv>, a: ArtifactRow, allowConnect: string[]): ArtifactSummary {
  return {
    id: a.id,
    url: artifactUrl(c, a.id),
    title: a.title,
    description: a.description,
    version: a.current_version,
    updated_at: a.updated_at,
    allow_connect: allowConnect,
  };
}

async function readJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "bad_request", "The body must be JSON.") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    return { ok: false, res: apiError(c, 400, "invalid_manifest", message) };
  }
  return { ok: true, value: parsed.data };
}

/** Looks up every file of the manifest in R2 and returns the version's file table. */
async function resolveFiles(
  c: Context<AppEnv>,
  manifest: Manifest,
): Promise<{ ok: true; files: Record<string, VersionFile> } | { ok: false; res: Response }> {
  const files: Record<string, VersionFile> = {};
  let total = 0;
  const missing: string[] = [];
  await Promise.all(
    Object.entries(manifest.files).map(async ([path, ref]) => {
      const sha256 = hashOf(ref);
      const head = await c.env.BLOBS.head(blobKey(sha256));
      if (!head) {
        missing.push(path);
        return;
      }
      total += head.size;
      files[path] = { sha256, size: head.size, type: contentTypeFor(path)! };
    }),
  );
  if (missing.length) {
    return {
      ok: false,
      res: apiError(c, 400, "missing_blobs", `These files were not uploaded: ${missing.sort().join(", ")}`, { missing }),
    };
  }
  if (total > MAX_VERSION_BYTES) {
    return { ok: false, res: apiError(c, 413, "too_large", `A version may hold at most 100MB; this one is ${Math.ceil(total / 1048576)}MB.`) };
  }
  return { ok: true, files };
}

// --- Pairing (unsigned: this is how a device gets its key registered) ---

const pairStartSchema = z.object({
  name: z.string().trim().min(1).max(64),
  public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "public_key must be a raw Ed25519 key in base64url"),
});

api.post("/devices/pair", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.PAIR_LIMITER) {
    const { success } = await c.env.PAIR_LIMITER.limit({ key: ip });
    if (!success) return apiError(c, 429, "rate_limited", "Too many login attempts. Wait a minute and try again.");
  }
  const parsed = await readJson(c, pairStartSchema);
  if (!parsed.ok) return parsed.res;
  const now = new Date();
  const pending = await c.env.DB.prepare("select count(*) as n from pairings where status = 'pending' and expires_at > ?")
    .bind(now.toISOString())
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PAIRINGS) {
    return apiError(c, 429, "rate_limited", "Too many logins are waiting for approval. Approve or let them expire first.");
  }
  const code = pairingCode();
  const expires = new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString();
  await c.env.DB.prepare("insert into pairings (code, name, public_key, requested_ip, expires_at) values (?, ?, ?, ?, ?)")
    .bind(code, parsed.value.name, parsed.value.public_key, ip, expires)
    .run();
  return c.json<PairStartResponse>({ code, approve_url: `${c.get("config").origin}/pair/${code}`, expires_at: expires }, 201);
});

api.get("/devices/pair/:code", async (c) => {
  const row = await c.env.DB.prepare("select status, device_id, expires_at from pairings where code = ?")
    .bind(c.req.param("code"))
    .first<{ status: string; device_id: string | null; expires_at: string }>();
  if (!row) return c.json<PairPollResponse>({ status: "expired" });
  if (row.status === "approved" && row.device_id) return c.json<PairPollResponse>({ status: "approved", device_id: row.device_id });
  if (row.status === "denied") return c.json<PairPollResponse>({ status: "denied" });
  if (Date.parse(row.expires_at) <= Date.now()) return c.json<PairPollResponse>({ status: "expired" });
  return c.json<PairPollResponse>({ status: "pending" });
});

// --- Everything below is signed by a paired device ---

const signed = new Hono<AppEnv>();
signed.use(requireDevice());

const checkSchema = z.object({ hashes: z.array(z.string().regex(SHA256_HEX)).max(MAX_FILES_PER_VERSION) });

signed.post("/blobs/check", async (c) => {
  const parsed = await readJson(c, checkSchema);
  if (!parsed.ok) return parsed.res;
  const unique = [...new Set(parsed.value.hashes)];
  const heads = await Promise.all(unique.map((h) => c.env.BLOBS.head(blobKey(h))));
  return c.json<BlobCheckResponse>({ missing: unique.filter((_, i) => !heads[i]) });
});

signed.put("/blobs/:sha256{[0-9a-f]{64}}", async (c) => {
  const sha256 = c.req.param("sha256");
  const length = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(length) || length < 0) {
    return apiError(c, 411, "length_required", "Send Content-Length with the file.");
  }
  if (length > MAX_FILE_BYTES) {
    return apiError(c, 413, "too_large", `A file may be at most 25MB; this one is ${Math.ceil(length / 1048576)}MB.`);
  }
  if (await c.env.BLOBS.head(blobKey(sha256))) return c.body(null, 204);
  try {
    // Streamed without reading it here; R2 rejects the write if the bytes do not hash to sha256.
    await c.env.BLOBS.put(blobKey(sha256), c.req.raw.body ?? new Uint8Array(), { sha256 });
  } catch {
    return apiError(c, 400, "bad_content_hash", "The file does not match its sha256.");
  }
  return c.body(null, 201);
});

signed.post("/artifacts", async (c) => {
  const parsed = await readJson(c, manifestSchema);
  if (!parsed.ok) return parsed.res;
  const manifest = parsed.value;
  const resolved = await resolveFiles(c, manifest);
  if (!resolved.ok) return resolved.res;
  const id = randomId();
  await createArtifact(c.env.DB, id, {
    title: manifest.title,
    description: manifest.description,
    entry: manifest.entry,
    files: resolved.files,
    allowConnect: manifest.allow_connect ?? [],
    deviceId: c.get("device").id,
  });
  return c.json<PublishResponse>({ id, url: artifactUrl(c, id), version: 1 }, 201);
});

function conflict(c: Context<AppEnv>, current: number) {
  return apiError(
    c,
    409,
    "version_conflict",
    `Version ${current} is the latest. Read it, merge your changes into it, and publish again.`,
    { current_version: current },
  );
}

signed.put("/artifacts/:id", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const parsed = await readJson(c, manifestSchema);
  if (!parsed.ok) return parsed.res;
  const manifest = parsed.value;
  const base = manifest.base_version ?? artifact.current_version;
  if (base !== artifact.current_version) return conflict(c, artifact.current_version);
  const resolved = await resolveFiles(c, manifest);
  if (!resolved.ok) return resolved.res;
  const added = await addVersion(c.env.DB, artifact.id, base, {
    title: manifest.title,
    description: manifest.description,
    entry: manifest.entry,
    files: resolved.files,
    allowConnect: manifest.allow_connect ?? [],
    deviceId: c.get("device").id,
  });
  if (!added) {
    const latest = await getArtifact(c.env.DB, artifact.id);
    return conflict(c, latest?.current_version ?? base + 1);
  }
  return c.json<PublishResponse>({ id: artifact.id, url: artifactUrl(c, artifact.id), version: base + 1 });
});

signed.get("/artifacts", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 200);
  const rows = await listArtifacts(c.env.DB, limit);
  return c.json<ListResponse>({ artifacts: rows.map((a) => summary(c, a, a.allow_connect)) });
});

signed.get("/artifacts/:id", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const versions = await listVersions(c.env.DB, artifact.id);
  const current = versions.find((v) => v.version === artifact.current_version);
  return c.json<ArtifactDetail>({
    ...summary(c, artifact, current?.allow_connect ?? []),
    versions: versions.map((v) => ({
      version: v.version,
      entry: v.entry,
      files: v.files,
      created_by: v.created_by,
      created_at: v.created_at,
    })),
  });
});

signed.get("/artifacts/:id/files/*", async (c) => {
  const artifact = await getArtifact(c.env.DB, c.req.param("id"));
  if (!artifact) return apiError(c, 404, "not_found", "No artifact has this id (or it is in the trash).");
  const requested = Number(c.req.query("version") ?? artifact.current_version);
  const version = await getVersion(c.env.DB, artifact.id, requested);
  if (!version) return apiError(c, 404, "not_found", `Version ${requested} does not exist.`);
  const prefix = `/api/v1/artifacts/${artifact.id}/files/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)) || version.entry;
  const file = version.files[path];
  if (!file) return apiError(c, 404, "not_found", `Version ${requested} has no file ${path}.`);
  const object = await c.env.BLOBS.get(blobKey(file.sha256));
  if (!object) return apiError(c, 500, "blob_missing", `The stored bytes of ${path} are missing.`);
  return new Response(object.body, { headers: { "content-type": file.type, "x-artifact-version": String(version.version) } });
});

signed.delete("/artifacts/:id", async (c) => {
  const trashed = await trashArtifact(c.env.DB, c.req.param("id"));
  if (!trashed) return apiError(c, 404, "not_found", "No artifact has this id (or it is already in the trash).");
  return c.json({ trashed: true, restore: `${c.get("config").origin}/settings#trash` });
});

const loginLinkSchema = z.object({ next: z.string().max(2000).optional() });

/**
 * A single-use sign-in link for the browser, for `artifact open`. It signs in as the user who
 * approved this device. Devices approved before users existed sign in as the owner (who is
 * created here if nobody has signed in yet).
 */
signed.post("/login-links", async (c) => {
  const parsed = await readJson(c, loginLinkSchema);
  if (!parsed.ok) return parsed.res;
  const device = c.get("device");
  const user =
    (device.userId && (await getUser(c.env.DB, device.userId))) ||
    (await firstRoot(c.env.DB)) ||
    (await createUser(c.env.DB, { name: "Owner", role: "root" }));
  const next = parsed.value.next?.startsWith("/") && !parsed.value.next.startsWith("//") ? parsed.value.next : "/";
  const token = await createLoginLink(c.env.DB, user.id, next);
  return c.json({ url: `${c.get("config").origin}/auth/link/${token}`, expires_in: LOGIN_LINK_SECONDS }, 201);
});

api.route("/", signed);
