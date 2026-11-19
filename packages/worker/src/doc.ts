/**
 * Pages written in the browser are Markdown (their entry is a .md file). They are shown and
 * edited inside the same sandbox as every other page: the renderer and the editor below are
 * served from /c/<token>/!artifact/ and load their libraries from the CDN with pinned versions
 * (and integrity hashes where the CDN serves a fixed file). The app's own pages load nothing
 * from outside.
 */
export const DOC_PATH = "!artifact/doc.html";
export const EDITOR_PATH = "!artifact/editor.html";

/** The frame URL of a version: its entry, or the Markdown renderer for a .md entry. */
export function frameSrc(token: string, entry: string): string {
  return `/c/${token}/${entry.endsWith(".md") ? DOC_PATH : encodeURI(entry)}`;
}

const MARKED = `<script src="https://cdn.jsdelivr.net/npm/marked@18.2.1/lib/marked.umd.js" integrity="sha384-eGsnYqMR1DwKM8Hap0jzlzZulA9iLneQ1yxDuryiYhQd2xn7qVXF+6yXoP7plj95" crossorigin="anonymous"></script>`;
const PURIFY = `<script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.18/dist/purify.min.js" integrity="sha384-lkArbWjiZKuE+bzKbj1vOEF7DKYBDNvgwZMCt5OH8bdRB92zpzyNska9Q/XKPHQD" crossorigin="anonymous"></script>`;
const EDITOR_CSS = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toast-ui/editor@3.2.3/dist/toastui-editor.css" integrity="sha384-udi9FPDSHUG6vLHzZhP8WMnN+ELzFMPWKKV1W7l5SgATWCeWCqSCbCSIHn6oCjwX" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toast-ui/editor@3.2.3/dist/theme/toastui-editor-dark.css" integrity="sha384-Ok3+liBSwABxWE//cTHVpZ2V85VPNgjNP+S5en3dpDbW0Aut8M/BBjKy2WxjJj+g" crossorigin="anonymous">`;
/** The editor as an ES module; its ProseMirror imports resolve to the same CDN. */
export const EDITOR_MODULE = "https://cdn.jsdelivr.net/npm/@toast-ui/editor@3.2.3/+esm";

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The renderer page: `entry` relative to the token's root; `nav` adds the viewer's link script. */
export function docHtml(entry: string, nav: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="doc.css">${MARKED}${PURIFY}</head>
<body><main id="doc" data-src="../${esc(encodeURI(entry))}"><p class="loading">Loading…</p></main>
<script src="doc.js"></script>${nav ? `<script src="nav.js"></script>` : ""}</body></html>`;
}

export const DOC_JS = `(async () => {
  const main = document.getElementById("doc");
  let md;
  try { md = await (await fetch(main.dataset.src)).text(); } catch { main.textContent = "This page could not be loaded."; return; }
  if (!window.marked || !window.DOMPurify) {
    // The renderer's libraries did not load: show the Markdown as it is written.
    const pre = document.createElement("pre"); pre.className = "raw"; pre.textContent = md; main.replaceChildren(pre); return;
  }
  main.innerHTML = DOMPurify.sanitize(marked.parse(md, { gfm: true }));
  for (const a of main.querySelectorAll("a[href]")) {
    let url; try { url = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (url.host !== location.host) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  }
  const h = main.querySelector("h1"); if (h && !document.title) document.title = h.textContent;
  // Rendered: the viewer can now mark the passages that have comments.
  if (window.parent !== window) window.parent.postMessage({ type: "artifact:ready" }, "*");
})();
`;

export const DOC_CSS = `
:root { color-scheme: light dark; --text: #1a1a19; --text-2: #5f5e5a; --bg: #ffffff; --surface-2: #f1f1ef; --border: #e4e3df; --accent: #2f5bd3; }
@media (prefers-color-scheme: dark) { :root { --text: #ecebe8; --text-2: #a9a8a3; --bg: #1c1c1b; --surface-2: #262625; --border: #3a3a38; --accent: #7c9dff; } }
html { background: var(--bg); color: var(--text); }
body { margin: 0; font: 400 16px/1.7 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }
h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.5em; } h1 { font-size: 30px; margin-top: 0; } h2 { font-size: 22px; } h3 { font-size: 18px; }
a { color: var(--accent); }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface-2); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--surface-2); padding: 12px 14px; border-radius: 8px; overflow: auto; } pre code { background: none; padding: 0; }
pre.raw { white-space: pre-wrap; font: 14px/1.6 ui-monospace, monospace; }
blockquote { margin: 0; padding: 0 16px; border-left: 3px solid var(--border); color: var(--text-2); }
table { border-collapse: collapse; } th, td { border: 1px solid var(--border); padding: 6px 10px; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid var(--border); }
.loading { color: var(--text-2); }
mark.artifact-comment { background: color-mix(in srgb, #f5c400 35%, transparent); color: inherit; cursor: pointer; border-radius: 2px; }
`;

/** The editor page, inside the sandbox; the viewer's edit page asks it for the Markdown to save. */
export function editorHtml(entry: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${EDITOR_CSS}
<style>html, body { margin: 0; height: 100%; } #ed { height: 100%; } #plain { box-sizing: border-box; width: 100%; height: 100%; border: 0; padding: 20px; font: 15px/1.6 ui-monospace, monospace; resize: none; outline: none; }
@media (prefers-color-scheme: dark) { html, #plain { background: #1c1c1b; color: #ecebe8; } }</style></head>
<body><div id="ed" data-src="../${esc(encodeURI(entry))}"></div><script type="module" src="editor.js"></script></body></html>`;
}

export const EDITOR_JS = `const host = document.getElementById("ed");
const initial = await (await fetch(host.dataset.src)).text();
let get, insert;
try {
  const load = import(${JSON.stringify(EDITOR_MODULE)});
  const { default: Editor } = await Promise.race([load, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 15000))]);
  const ed = new Editor({
    el: host, height: "100%", initialEditType: "wysiwyg", previewStyle: "vertical", initialValue: initial,
    usageStatistics: false, autofocus: false, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  });
  get = () => ed.getMarkdown();
  insert = (text) => ed.insertText(text);
} catch {
  // Without the editor's library, the Markdown is edited as text.
  const area = document.createElement("textarea");
  area.id = "plain"; area.value = initial; area.spellcheck = true;
  host.replaceWith(area);
  get = () => area.value;
  insert = (text) => { area.setRangeText(text, area.selectionStart, area.selectionEnd, "end"); area.focus(); };
}
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const d = e.data || {};
  if (d.type === "artifact:get") window.parent.postMessage({ type: "artifact:markdown", markdown: get() }, "*");
  if (d.type === "artifact:insert" && typeof d.text === "string") insert(d.text);
});
window.parent.postMessage({ type: "artifact:editor-ready" }, "*");
`;

/** The ids of the pages on `host` that Markdown links to: [text](/a/<id>) or a full URL. */
export function markdownLinks(md: string, origin: string): string[] {
  const host = new URL(origin).host;
  const out = new Set<string>();
  for (const m of md.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>/g)) {
    let url: URL;
    try {
      url = new URL(m[1] ?? m[2]!, origin);
    } catch {
      continue;
    }
    const id = /^\/a\/([0-9a-z]{16})(?:\/|$)/.exec(url.pathname)?.[1];
    if (id && url.host === host) out.add(id);
  }
  return [...out].slice(0, 1000);
}
