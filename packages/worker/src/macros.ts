/**
 * Macros in Markdown pages. A line of its own such as {{children}} becomes something the
 * renderer builds in the sandbox:
 *
 *   {{toc}}             the page's sections (built from its headings, needs nothing else)
 *   {{children}}        the pages under this one
 *   {{recent}}          the pages of this project changed last
 *   {{label decision}}  the pages with a label
 *   {{include <url>}}   another Markdown page of the same project, shown in place
 *
 * What a macro shows that the page does not hold comes from !artifact/macros.json, made when the
 * renderer asks for it, for the person the viewer token was minted for: only pages they may see.
 * A public link gets none of it.
 */
import { labelSchema } from "@artifact/shared";
import type { Role } from "./app-env.ts";
import { childrenOf, getArtifact, getVersion, listArtifacts, listProjectPages, type ArtifactRow } from "./db/artifacts.ts";
import { accessFor } from "./db/access.ts";

export const MACROS_PATH = "!artifact/macros.json";
const MAX_LABEL_MACROS = 5;
const MAX_INCLUDES = 5;
const MAX_INCLUDE_BYTES = 200_000;
const LIST_LENGTH = 50;
const RECENT_LENGTH = 10;

export interface MacroPage {
  title: string;
  href: string;
  updated_at?: string;
}

export interface MacroData {
  /** On a public link: nothing beyond the page itself is shown. */
  public?: boolean;
  children?: MacroPage[];
  recent?: MacroPage[];
  /** Keyed by the label as written in the macro. */
  labels?: Record<string, MacroPage[]>;
  /** Keyed by the page as written in the macro. */
  include?: Record<string, { title: string; href: string; markdown: string } | { error: string }>;
}

const MACRO_LINE = /^ {0,3}\{\{\s*(children|toc|recent|include|label)(?:\s+([^{}\n]*?))?\s*\}\}[ \t]*$/;

/** The macros a page uses: lines of their own, outside fenced code. */
export function macrosIn(md: string): { name: string; arg: string }[] {
  const out: { name: string; arg: string }[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = MACRO_LINE.exec(line);
    if (m) out.push({ name: m[1]!, arg: (m[2] ?? "").trim() });
  }
  return out;
}

/** The page an {{include}} names: its URL, /a/<id>, or the id. */
export function includedId(arg: string): string | undefined {
  const m = /^(?:([0-9a-z]{16})|(?:https?:\/\/[^/\s]+)?\/a\/([0-9a-z]{16})(?:[/?#]\S*)?)$/.exec(arg.trim());
  return m ? (m[1] ?? m[2]) : undefined;
}

const href = (id: string) => `/a/${id}`;

/** The data for the macros in `md`, a version of `page`, as `viewer` may see it. */
export async function macroData(
  db: D1Database,
  readText: (sha256: string) => Promise<string | null>,
  page: ArtifactRow,
  md: string,
  viewer: { userId: string; role: Role },
): Promise<MacroData> {
  const used = macrosIn(md);
  const names = new Set(used.map((m) => m.name));
  const out: MacroData = {};
  const access = await accessFor(db, viewer);
  if (names.has("children")) {
    const tree = (await listProjectPages(db, page.project)).filter((r) => !access.hiddenPages.has(r.id));
    out.children = (childrenOf(tree).get(page.id) ?? []).map((r) => ({ title: r.title, href: href(r.id) }));
  }
  if (names.has("recent")) {
    out.recent = (await listArtifacts(db, RECENT_LENGTH * 3, page.project))
      .filter((a) => access.sees(a))
      .slice(0, RECENT_LENGTH)
      .map((a) => ({ title: a.title, href: href(a.id), updated_at: a.updated_at }));
  }
  const labelArgs = [...new Set(used.filter((m) => m.name === "label").map((m) => m.arg))].slice(0, MAX_LABEL_MACROS);
  if (labelArgs.length) {
    out.labels = {};
    for (const arg of labelArgs) {
      const label = labelSchema.safeParse(arg);
      out.labels[arg] = label.success
        ? (await listArtifacts(db, LIST_LENGTH, undefined, label.data))
            .filter((a) => access.sees(a))
            .map((a) => ({ title: a.title, href: href(a.id), updated_at: a.updated_at }))
        : [];
    }
  }
  const includeArgs = [...new Set(used.filter((m) => m.name === "include").map((m) => m.arg))].slice(0, MAX_INCLUDES);
  if (includeArgs.length) {
    out.include = {};
    for (const arg of includeArgs) {
      const id = includedId(arg);
      const target = id ? await getArtifact(db, id) : null;
      if (!target || target.project !== page.project || !access.sees(target)) {
        out.include[arg] = { error: "Only a page of the same project can be embedded." };
        continue;
      }
      if (target.id === page.id) {
        out.include[arg] = { error: "A page cannot embed itself." };
        continue;
      }
      const version = await getVersion(db, target.id, target.current_version);
      const file = version?.entry.endsWith(".md") ? version.files[version.entry] : undefined;
      if (!file) {
        out.include[arg] = { error: "Only a page written in Markdown can be embedded." };
        continue;
      }
      const text = file.size <= MAX_INCLUDE_BYTES ? await readText(file.sha256) : null;
      out.include[arg] = text === null ? { error: "That page is too large to embed." } : { title: target.title, href: href(target.id), markdown: text };
    }
  }
  return out;
}
