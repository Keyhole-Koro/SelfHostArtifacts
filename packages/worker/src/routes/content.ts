import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import { contentHeaders, readContentToken } from "../content.ts";
import { getArtifact, getVersion } from "../db/artifacts.ts";
import { blobKey } from "./api.ts";
import { shareActive } from "../share.ts";

/**
 * Serves an artifact's files at /c/:token/<path>. The token (from the viewer page) says which
 * artifact and version; relative URLs in the page resolve under the same token, so no cookie
 * is involved. Every response carries the CSP sandbox, so the page runs in an opaque origin
 * even when opened outside the viewer's iframe.
 */
export const content = new Hono<AppEnv>();

/**
 * Served beside every page opened in the viewer, and loaded from the end of its HTML. A click on a
 * link to another artifact on this host asks the viewer (the parent frame) to go there, since
 * the sandbox does not let the page navigate the viewer itself. The viewer checks the path. On
 * a page opened in a tab of its own, or through a public link, it does nothing.
 */
export const NAV_PATH = "!artifact/nav.js"; // "!" cannot start a published file's name, so no page can clash with it
const NAV_JS = `(() => {
  if (window.parent === window) return;
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== "_self") return;
    let url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch { return; }
    if (url.host !== location.host || !/^\/a\/[0-9a-z]{16}(\/v\/[0-9]+)?\/?$/.test(url.pathname)) return;
    e.preventDefault();
    window.parent.postMessage({ type: "artifact:navigate", path: url.pathname + url.hash }, "*");
  });
})();
`;

/** The bytes of `body`, then `tail`. */
function withTail(body: ReadableStream<Uint8Array>, tail: Uint8Array): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      controller.enqueue(tail);
    },
  });
  void body.pipeTo(writable);
  return readable;
}

function plain(status: number, text: string, allowConnect: string[] = []) {
  const headers = contentHeaders("text/plain; charset=utf-8", allowConnect);
  return new Response(text, { status, headers });
}

content.on(["GET", "HEAD"], "/:token/*", async (c) => {
  const token = c.req.param("token");
  const claims = await readContentToken(c.env.CONTENT_TOKEN_SECRET, token);
  if (!claims) return plain(403, "This link has expired. Reopen the artifact from its page.");
  const artifact = await getArtifact(c.env.DB, claims.a);
  if (!artifact) return plain(404, "This artifact was deleted.");
  // A token from a public link dies with the link: turned off, replaced or expired.
  if (claims.s !== undefined && !(shareActive(artifact) && artifact.share_nonce === claims.s)) {
    return plain(403, "This public link was turned off or has expired.");
  }
  const version = await getVersion(c.env.DB, claims.a, claims.v);
  if (!version) return plain(404, "This version no longer exists.");

  let path: string;
  try {
    path = decodeURIComponent(c.req.path.slice(`/c/${token}/`.length));
  } catch {
    return plain(400, "Bad path.");
  }
  if (path === "" || path.endsWith("/")) path = path + (path === "" ? version.entry : "index.html");
  const viewerFrame = claims.s === undefined;
  if (path === NAV_PATH && viewerFrame) {
    const headers = contentHeaders("text/javascript; charset=utf-8", version.allow_connect);
    return new Response(c.req.method === "HEAD" ? null : NAV_JS, { headers });
  }
  const file = version.files[path];
  if (!file) return plain(404, `No file ${path} in this artifact.`);

  const headers = contentHeaders(file.type, version.allow_connect);
  // An HTML page opened in the viewer gets the link script after its last byte: no parsing, so
  // no CPU time to speak of. Content after </html> still runs, in the body.
  const tail = viewerFrame && file.type.startsWith("text/html") ? new TextEncoder().encode(`\n<script src="/c/${token}/${NAV_PATH}"></script>\n`) : undefined;
  headers.set("content-length", String(file.size + (tail?.length ?? 0)));
  if (c.req.method === "HEAD") return new Response(null, { headers });
  const object = await c.env.BLOBS.get(blobKey(file.sha256));
  if (!object) return plain(500, `The stored bytes of ${path} are missing.`);
  return new Response(tail ? withTail(object.body, tail) : object.body, { headers });
});
