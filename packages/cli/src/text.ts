/**
 * What a page says and what it links to, read from its HTML when it is published, so the server
 * can search it, show what links to each page and compare versions without parsing anything
 * itself. Text that a page's scripts write at run time is not seen.
 */
import { MAX_TEXT_CHARS } from "@artifact/shared";

const BLOCK = /<\/?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|thead|tbody|section|article|header|footer|main|nav|aside|pre|blockquote|figure|figcaption|dt|dd|dl|details|summary|br|hr|title|label|button|option)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", middot: "·", rarr: "→", larr: "←", copy: "©" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The visible text of an HTML document, one line per block, without scripts, styles or markup. */
export function pageText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]*>/g, " ");
  const lines = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return lines.join("\n").slice(0, MAX_TEXT_CHARS);
}

/** The ids of the pages on `origin` that the HTML links to (/a/<id>, absolute or from the root). */
export function pageLinks(html: string, origin: string): string[] {
  const host = new URL(origin).host;
  const out = new Set<string>();
  for (const m of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)) {
    let url: URL;
    try {
      url = new URL(decode(m[2]!), origin);
    } catch {
      continue;
    }
    const id = /^\/a\/([0-9a-z]{16})(?:\/|$)/.exec(url.pathname)?.[1];
    if (id && url.host === host) out.add(id);
  }
  return [...out].slice(0, 1000);
}
