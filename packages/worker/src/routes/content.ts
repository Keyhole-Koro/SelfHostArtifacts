import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import { contentHeaders, readContentToken } from "../content.ts";
import { getArtifact, getVersion } from "../db/artifacts.ts";
import { blobKey } from "./api.ts";

/**
 * Serves an artifact's files at /c/:token/<path>. The token (from the viewer page) says which
 * artifact and version; relative URLs in the page resolve under the same token, so no cookie
 * is involved. Every response carries the CSP sandbox, so the page runs in an opaque origin
 * even when opened outside the viewer's iframe.
 */
export const content = new Hono<AppEnv>();

function plain(status: number, text: string, allowConnect: string[] = []) {
  const headers = contentHeaders("text/plain; charset=utf-8", allowConnect);
  return new Response(text, { status, headers });
}

content.on(["GET", "HEAD"], "/:token/*", async (c) => {
  const token = c.req.param("token");
  const claims = await readContentToken(c.env.CONTENT_TOKEN_SECRET, token);
  if (!claims) return plain(403, "This link has expired. Reopen the article from its page.");
  const artifact = await getArtifact(c.env.DB, claims.a);
  if (!artifact) return plain(404, "This article was deleted.");
  const version = await getVersion(c.env.DB, claims.a, claims.v);
  if (!version) return plain(404, "This version no longer exists.");

  let path: string;
  try {
    path = decodeURIComponent(c.req.path.slice(`/c/${token}/`.length));
  } catch {
    return plain(400, "Bad path.");
  }
  if (path === "" || path.endsWith("/")) path = path + (path === "" ? version.entry : "index.html");
  const file = version.files[path];
  if (!file) return plain(404, `No file ${path} in this article.`);

  const headers = contentHeaders(file.type, version.allow_connect);
  headers.set("content-length", String(file.size));
  if (c.req.method === "HEAD") return new Response(null, { headers });
  const object = await c.env.BLOBS.get(blobKey(file.sha256));
  if (!object) return plain(500, `The stored bytes of ${path} are missing.`);
  return new Response(object.body, { headers });
});
