import {
  CONTENT_HASH_HEADER,
  EMPTY_SHA256,
  MAX_CLOCK_SKEW_SECONDS,
  SHA256_HEX,
  canonicalRequest,
  parseSignatureHeader,
} from "@artifact/shared";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import { apiError } from "../lib/api-error.ts";
import { fromBase64url, sha256Hex, utf8 } from "../lib/encoding.ts";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

/**
 * Authenticates an agent request signed with a paired device's Ed25519 key.
 *
 * Blob uploads (`PUT /api/v1/blobs/:sha256`) are streamed straight into R2 without being
 * read, so their body hash is taken from the path and checked by R2 on write. Every other
 * request has a small JSON body (or none), which is hashed here and compared.
 */
export function requireDevice(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const params = parseSignatureHeader(c.req.header("authorization"));
    if (!params) return apiError(c, 401, "unauthenticated", "This request is not signed. Run `artifact login` first.");

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - params.ts) > MAX_CLOCK_SKEW_SECONDS) {
      return apiError(c, 401, "clock_skew", "The request timestamp is more than 5 minutes off. Check this computer's clock.");
    }

    const device = await c.env.DB.prepare("select id, name, public_key from devices where id = ? and revoked_at is null")
      .bind(params.key)
      .first<{ id: string; name: string; public_key: string }>();
    if (!device) {
      return apiError(c, 401, "unknown_device", "This device is not registered or was revoked. Run `artifact login` again.");
    }

    const declared = c.req.header(CONTENT_HASH_HEADER)?.toLowerCase() ?? EMPTY_SHA256;
    if (!SHA256_HEX.test(declared)) return apiError(c, 400, "bad_content_hash", `${CONTENT_HASH_HEADER} must be a hex sha256`);
    const blobHash = c.req.method === "PUT" ? /^\/api\/v1\/blobs\/([0-9a-f]{64})$/.exec(c.req.path)?.[1] : undefined;
    if (blobHash) {
      if (declared !== blobHash) return apiError(c, 400, "bad_content_hash", "The content hash does not match the blob path.");
    } else {
      if (Number(c.req.header("content-length") ?? 0) > MAX_JSON_BODY_BYTES) {
        return apiError(c, 413, "too_large", "The request body is larger than 1MB.");
      }
      const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      if (body.length > MAX_JSON_BODY_BYTES) return apiError(c, 413, "too_large", "The request body is larger than 1MB.");
      if ((await sha256Hex(body)) !== declared) {
        return apiError(c, 400, "bad_content_hash", "The body does not match its declared hash.");
      }
    }

    const url = new URL(c.req.url);
    const message = canonicalRequest(c.req.method, url.pathname + url.search, params.ts, params.nonce, declared);
    let valid = false;
    try {
      const key = await crypto.subtle.importKey("raw", fromBase64url(device.public_key), { name: "Ed25519" }, false, ["verify"]);
      valid = await crypto.subtle.verify("Ed25519", key, fromBase64url(params.sig), utf8(message));
    } catch {
      valid = false;
    }
    if (!valid) return apiError(c, 401, "bad_signature", "The request signature is invalid.");

    // Reject replays: each nonce is accepted once within the allowed clock skew.
    const expires = new Date((now + MAX_CLOCK_SKEW_SECONDS * 2) * 1000).toISOString();
    const inserted = await c.env.DB.prepare("insert or ignore into nonces (nonce, expires_at) values (?, ?)")
      .bind(`${device.id}:${params.nonce}`, expires)
      .run();
    if (inserted.meta.changes === 0) return apiError(c, 401, "replayed", "This request was already received.");

    c.executionCtx.waitUntil(
      c.env.DB.prepare("update devices set last_used_at = ? where id = ?").bind(new Date().toISOString(), device.id).run(),
    );
    c.set("device", { id: device.id, name: device.name });
    await next();
  };
}
