/**
 * Changing an HTML page's source in the browser. The editor runs inside the page's sandbox, like
 * the Markdown editor: !artifact/source.html loads CodeMirror 5 from cdnjs (pinned, with integrity
 * hashes; a plain text box without it), reads the page's text files once from
 * !artifact/raw/<path> (their bytes, without the viewer's link script), and shows the page being
 * edited in a preview frame whose base is the page's own files. The edit page outside asks it for
 * the changed files and saves them; the server reads the text and links from the HTML again.
 */
import type { VersionFile } from "@artifact/shared";

export const SOURCE_PATH = "!artifact/source.html";
export const SOURCE_JS_PATH = "!artifact/source.js";
export const RAW_PREFIX = "!artifact/raw/";
export const MAX_SOURCE_BYTES = 1_000_000;
const EDITABLE = /\.(html?|css|m?js|json|svg|txt|md|csv|xml|ya?ml)$/i;

/** The files of a version that can be changed as text: the entry first, then by path. */
export function editableFiles(files: Record<string, VersionFile>, entry: string): string[] {
  const all = Object.entries(files)
    .filter(([path, file]) => EDITABLE.test(path) && file.size <= MAX_SOURCE_BYTES)
    .map(([path]) => path)
    .sort();
  return all.includes(entry) ? [entry, ...all.filter((p) => p !== entry)] : all;
}

const attr = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function sourceHtml(files: string[], entry: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/codemirror.min.css" integrity="sha512-yAvYFCgl0jKssk1XXo079Ec7sVXfN3OIotWiUP7zTrHhcRxMgRnEFjYhesnBZSfYPkd3sX7BmVTaWQLXvITMnQ==" crossorigin="anonymous" referrerpolicy="no-referrer">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/theme/material-darker.min.css" integrity="sha512-V9I4urh8HJtkmwDe5gEz/YGraX/rjM60xeDxXp8qV16GVWnFJQsGjDmjYgpzPrjlgnudQg0UxR/Tr3DK92hrWQ==" crossorigin="anonymous" referrerpolicy="no-referrer">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/codemirror.min.js" integrity="sha512-2GhuAIxcoXqN+nBSa8DZSpChVQNliC1wHHgTE6BEkISu+0+3ywUEF5RJrmWyD67Kxm6XjJkULfpU8hdzLMuFhA==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/xml/xml.min.js" integrity="sha512-AKfonnPRVxSiXGdFWIGewu1j9vgthX1dhL6Q24j/M+YQpxL+ukmwIBmoeVvjY5+UmxBXBCoCXhi2f4EhJvCwkw==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/javascript/javascript.min.js" integrity="sha512-k1xN8Ok3EjJVqkyue+rrYB9WJi34a101SAdtjJGS4sM0ZSFTb7IBseqeCL4OcKzmQRmtrKIYqVROZYIpHXc3Mg==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/css/css.min.js" integrity="sha512-MGm8eF2KK4SjMCaW47o79+MO+UnM0x6wG236/AZ9LcOiB+a5BSSeYFKIEj1/Typ4FjFS0fX7teop2/TEMUnNxw==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/htmlmixed/htmlmixed.min.js" integrity="sha512-8j7xRMYjyMMpQ8lyYEDe+JEQRwFZrGgtSTd22BhjAOQ1aRJjxaskQFjzCVrwagO1lV79RZu1E22Zm9tBmqRJTg==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<style>
html, body { margin: 0; height: 100%; }
body { font: 14px/1.5 system-ui, sans-serif; color: #1a1a19; background: #fff; }
#panes { display: flex; height: 100%; }
#code { flex: 1; min-width: 0; height: 100%; overflow: hidden; }
#preview { flex: 1; min-width: 0; height: 100%; border: 0; border-left: 1px solid #e4e3df; background: #fff; display: none; }
#panes[data-preview=on] #preview { display: block; }
.CodeMirror { height: 100%; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
textarea.plain { box-sizing: border-box; width: 100%; height: 100%; border: 0; padding: 16px; font: 13px/1.55 ui-monospace, monospace; resize: none; outline: none; tab-size: 2; }
#note { position: fixed; left: 12px; bottom: 12px; margin: 0; padding: 6px 10px; border-radius: 6px; background: #fdecea; color: #a1281e; }
@media (max-width: 760px) { #panes { flex-direction: column; } #preview { border-left: 0; border-top: 1px solid #e4e3df; } }
@media (prefers-color-scheme: dark) { body, textarea.plain { color: #ecebe8; background: #1c1c1b; } #preview { border-color: #3a3a38; } }
</style></head>
<body data-files="${attr(JSON.stringify(files))}" data-entry="${attr(entry)}">
<div id="panes" data-preview="off"><div id="code"></div><iframe id="preview" sandbox="allow-scripts allow-popups allow-forms" title="Preview"></iframe></div>
<p id="note" hidden></p>
<script src="source.js"></script></body></html>`;
}

export const SOURCE_JS = `(async () => {
  const body = document.body;
  const paths = JSON.parse(body.dataset.files), entry = body.dataset.entry;
  const host = new URL(location.href).origin;
  let root = new URL("../", location.href).href;
  const code = document.getElementById("code"), preview = document.getElementById("preview"), panes = document.getElementById("panes");
  const texts = {}, original = {}, failed = new Set(), forced = new Set();
  const rawUrl = (p) => root + "!artifact/raw/" + p.split("/").map(encodeURIComponent).join("/");
  // Every file is read once, now: the link to them expires, the edits stay here.
  await Promise.all(paths.map(async (p) => {
    try {
      const res = await fetch(rawUrl(p));
      if (!res.ok) throw new Error(String(res.status));
      texts[p] = original[p] = await res.text();
    } catch { texts[p] = original[p] = ""; failed.add(p); }
  }));
  const modeOf = (p) => /\\.(html?|svg|xml)$/i.test(p) ? "htmlmixed" : /\\.css$/i.test(p) ? "css" : /\\.json$/i.test(p) ? { name: "javascript", json: true } : /\\.m?js$/i.test(p) ? "javascript" : null;
  let current = null, show, replace, timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 400); };
  if (window.CodeMirror) {
    const docs = {};
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cm = CodeMirror(code, { lineNumbers: true, lineWrapping: true, indentUnit: 2, tabSize: 2, autofocus: true, theme: dark ? "material-darker" : "default" });
    cm.on("change", () => { if (current && !failed.has(current)) { texts[current] = cm.getValue(); schedule(); } });
    show = (p) => { if (!docs[p]) docs[p] = CodeMirror.Doc(texts[p], modeOf(p)); cm.swapDoc(docs[p]); cm.setOption("readOnly", failed.has(p)); };
    replace = (p, text) => { docs[p] = CodeMirror.Doc(text, modeOf(p)); texts[p] = text; if (p === current) cm.swapDoc(docs[p]); };
  } else {
    // Without the editor's library, the source is edited as plain text.
    const area = document.createElement("textarea");
    area.className = "plain"; area.spellcheck = false;
    code.append(area);
    area.addEventListener("input", () => { if (current && !failed.has(current)) { texts[current] = area.value; schedule(); } });
    show = (p) => { area.value = texts[p]; area.readOnly = failed.has(p); };
    replace = (p, text) => { texts[p] = text; if (p === current) area.value = text; };
  }
  const note = document.getElementById("note");
  const open = (p) => {
    if (!(p in texts)) return;
    current = p; show(p);
    note.hidden = !failed.has(p);
    note.textContent = failed.has(p) ? p + " could not be read; it stays as it is." : "";
    schedule();
  };
  const dirOf = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const esc = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  // The preview shows the page being edited with its own files: changed styles and scripts are
  // put in place of their links, and everything else loads as published.
  const render = () => {
    if (panes.dataset.preview !== "on") return;
    const page = /\\.html?$/i.test(current || "") ? current : entry;
    const dir = dirOf(page);
    let html = texts[page] || "";
    for (const p of paths) {
      if (p === page || texts[p] === original[p] || !p.startsWith(dir)) continue;
      const rel = esc(p.slice(dir.length));
      if (/\\.css$/i.test(p)) {
        html = html.replace(new RegExp("<link\\\\b[^>]*\\\\bhref=[\\"']?(?:\\\\./)?" + rel + "[\\"']?[^>]*>", "gi"), () => "<style>" + texts[p] + "</style>");
      } else if (/\\.m?js$/i.test(p)) {
        html = html.replace(new RegExp("<script\\\\b([^>]*?)\\\\bsrc=[\\"']?(?:\\\\./)?" + rel + "[\\"']?([^>]*)>\\\\s*</script>", "gi"), (m, a, b) => "<script" + a + b + ">" + texts[p].replace(/<\\/script/gi, "<\\\\/script") + "</script>");
      }
    }
    const base = '<base href="' + root + dir.split("/").map(encodeURIComponent).join("/") + '">';
    html = /<head\\b[^>]*>/i.test(html) ? html.replace(/<head\\b[^>]*>/i, (m) => m + base) : base + html;
    preview.srcdoc = html;
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data || {};
    if (d.type === "artifact:open" && typeof d.path === "string") open(d.path);
    if (d.type === "artifact:preview") { panes.dataset.preview = d.on ? "on" : "off"; render(); }
    if (d.type === "artifact:root" && typeof d.root === "string" && d.root.startsWith(host + "/c/")) root = d.root;
    if (d.type === "artifact:get-files") {
      const files = {};
      for (const p of paths) if (!failed.has(p) && (texts[p] !== original[p] || forced.has(p))) files[p] = texts[p];
      window.parent.postMessage({ type: "artifact:files", files }, "*");
    }
    if (d.type === "artifact:set-files" && d.files && typeof d.files === "object") {
      for (const [p, text] of Object.entries(d.files)) if (p in texts && typeof text === "string") { replace(p, text); forced.add(p); }
      // The merge marks the lines both changed: open the first file that has them.
      const marked = Object.keys(d.files).find((p) => /^<<<<<<< /m.test(String(d.files[p])));
      if (marked) { open(marked); window.parent.postMessage({ type: "artifact:opened", path: marked }, "*"); }
    }
  });
  open(entry in texts ? entry : paths[0]);
  window.parent.postMessage({ type: "artifact:editor-ready" }, "*");
})();
`;
