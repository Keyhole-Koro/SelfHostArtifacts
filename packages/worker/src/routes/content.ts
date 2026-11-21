import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import { contentHeaders, readContentToken } from "../content.ts";
import { getArtifact, getVersion } from "../db/artifacts.ts";
import { blobKey } from "./api.ts";
import { shareActive } from "../share.ts";
import { DOC_CSS, DOC_JS, DOC_PATH, EDITOR_JS, EDITOR_PATH, docHtml, editorHtml } from "../doc.ts";
import { MACROS_PATH, macroData, type MacroData } from "../macros.ts";
import { RAW_PREFIX, SOURCE_JS, SOURCE_JS_PATH, SOURCE_PATH, editableFiles, sourceHtml } from "../source.ts";
import type { Role } from "../app-env.ts";

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
 * the sandbox does not let the page navigate the viewer itself. The viewer checks the path. The
 * page's #fragment and the viewer's go together, so a link can open the page at a place in it.
 * On a page opened in a tab of its own, or through a public link, it does nothing.
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
    if (url.host !== location.host || !/^\\/a\\/[0-9a-z]{16}(\\/v\\/[0-9]+)?\\/?$/.test(url.pathname)) return;
    e.preventDefault();
    window.parent.postMessage({ type: "artifact:navigate", path: url.pathname + url.hash }, "*");
  });
  // The page's #fragment shows in the viewer's address bar, so a link to the viewer, or reloading
  // it, opens the page at the same place; one typed there comes in below. history.replaceState
  // fires no event, so the fragment is also checked every second.
  let hash = location.hash;
  const sendHash = () => {
    if (location.hash !== hash) { hash = location.hash; window.parent.postMessage({ type: "artifact:hash", hash }, "*"); }
  };
  window.addEventListener("hashchange", sendHash);
  setInterval(sendHash, 1000);
  // Comments: the selected passage goes to the viewer, and passages that have comments are marked.
  let last = "";
  const report = () => {
    const text = String(window.getSelection() || "").replace(/\\s+/g, " ").trim().slice(0, 500);
    if (text !== last) { last = text; window.parent.postMessage({ type: "artifact:selection", text }, "*"); }
  };
  document.addEventListener("mouseup", () => setTimeout(report, 0));
  document.addEventListener("keyup", report);
  const style = document.createElement("style");
  style.textContent = "mark.artifact-comment{background:rgba(245,196,0,.35);color:inherit;cursor:pointer;border-radius:2px}mark.artifact-comment.on{background:rgba(245,196,0,.7)}";
  document.head.append(style);
  function mark(id, quote) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest("script,style,mark.artifact-comment")) continue;
      const at = n.data.indexOf(quote);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at); range.setEnd(n, at + quote.length);
      const m = document.createElement("mark");
      m.className = "artifact-comment"; m.dataset.comment = id;
      m.addEventListener("click", (e) => { e.stopPropagation(); window.parent.postMessage({ type: "artifact:comment", id }, "*"); });
      range.surroundContents(m);
      return true;
    }
    return false;
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data || {};
    if (d.type === "artifact:highlight" && Array.isArray(d.quotes)) {
      for (const m of document.querySelectorAll("mark.artifact-comment")) m.replaceWith(...m.childNodes);
      for (const q of d.quotes) if (q && typeof q.id === "string" && typeof q.text === "string" && q.text) mark(q.id, q.text);
    }
    if (d.type === "artifact:focus") {
      for (const m of document.querySelectorAll("mark.artifact-comment")) m.classList.toggle("on", m.dataset.comment === d.id);
      const m = document.querySelector('mark.artifact-comment[data-comment="' + String(d.id).replace(/[^0-9a-z]/g, "") + '"]');
      if (m) m.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (d.type === "artifact:hash" && typeof d.hash === "string" && d.hash !== location.hash) {
      // A move within this document (an empty fragment still needs its "#"), never a reload.
      const url = new URL(location.href);
      url.hash = d.hash;
      hash = url.hash;
      location.replace(url.hash ? url.href : url.href + "#");
    }
  });
  const ready = () => window.parent.postMessage({ type: "artifact:ready" }, "*");
  if (document.readyState === "complete") ready(); else window.addEventListener("load", ready);
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
  const claims = await readContentToken(c.env.DB, c.env.CONTENT_TOKEN_SECRET, token);
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
  // The files that come with every page: the link script, and for a Markdown page its renderer
  // (also on public links) and its editor (only for the viewer).
  const builtIn: Record<string, [string, () => string] | undefined> = {
    [NAV_PATH]: viewerFrame ? ["text/javascript; charset=utf-8", () => NAV_JS] : undefined,
    [DOC_PATH]: version.entry.endsWith(".md") ? ["text/html; charset=utf-8", () => docHtml(version.entry, viewerFrame)] : undefined,
    "!artifact/doc.js": ["text/javascript; charset=utf-8", () => DOC_JS],
    "!artifact/doc.css": ["text/css; charset=utf-8", () => DOC_CSS],
    [EDITOR_PATH]: viewerFrame && version.entry.endsWith(".md") ? ["text/html; charset=utf-8", () => editorHtml(version.entry)] : undefined,
    "!artifact/editor.js": viewerFrame ? ["text/javascript; charset=utf-8", () => EDITOR_JS] : undefined,
    [SOURCE_PATH]: viewerFrame && !version.entry.endsWith(".md") ? ["text/html; charset=utf-8", () => sourceHtml(editableFiles(version.files, version.entry), version.entry)] : undefined,
    [SOURCE_JS_PATH]: viewerFrame ? ["text/javascript; charset=utf-8", () => SOURCE_JS] : undefined,
  };
  // The source editor reads a file's own bytes, without the link script the viewer appends.
  if (viewerFrame && path.startsWith(RAW_PREFIX)) {
    const name = path.slice(RAW_PREFIX.length);
    const file = editableFiles(version.files, version.entry).includes(name) ? version.files[name] : undefined;
    if (!file) return plain(404, `No file ${name} to edit in this artifact.`);
    const headers = contentHeaders("text/plain; charset=utf-8", version.allow_connect);
    headers.set("cache-control", "no-store");
    if (c.req.method === "HEAD") return new Response(null, { headers });
    const object = await c.env.BLOBS.get(blobKey(file.sha256));
    return object ? new Response(object.body, { headers }) : plain(500, `The stored bytes of ${name} are missing.`);
  }
  if (path === MACROS_PATH && version.entry.endsWith(".md")) {
    const headers = contentHeaders("application/json; charset=utf-8", version.allow_connect);
    headers.set("cache-control", "no-store");
    if (c.req.method === "HEAD") return new Response(null, { headers });
    let data: MacroData = { public: true };
    const user = viewerFrame && claims.u ? await c.env.DB.prepare("select id, role from users where id = ?").bind(claims.u).first<{ id: string; role: Role }>() : null;
    if (viewerFrame) data = {};
    const entry = version.files[version.entry];
    if (user && entry) {
      const readText = async (sha256: string) => (await c.env.BLOBS.get(blobKey(sha256)))?.text() ?? null;
      const md = await readText(entry.sha256);
      if (md !== null) data = await macroData(c.env.DB, readText, artifact, md, { userId: user.id, role: user.role });
    }
    return new Response(JSON.stringify(data), { headers });
  }
  const own = builtIn[path];
  if (own) {
    const headers = contentHeaders(own[0], version.allow_connect);
    return new Response(c.req.method === "HEAD" ? null : own[1](), { headers });
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
