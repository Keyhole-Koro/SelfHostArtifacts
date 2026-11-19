/**
 * What a new page written in the browser starts from: a built-in template, or a Markdown page of
 * the same project labeled "template" (its text, under the new title, with its other labels).
 */
export interface Template {
  id: string;
  name: string;
  /** Labels the new page gets. */
  labels: string[];
  body: (title: string, today: string) => string;
}

export const TEMPLATE_LABEL = "template";

export const BUILT_IN_TEMPLATES: Template[] = [
  { id: "blank", name: "Blank page", labels: [], body: (t) => `# ${t}\n\n` },
  {
    id: "meeting",
    name: "Meeting notes",
    labels: ["meeting"],
    body: (t, d) => `# ${t}\n\n**Date:** ${d}\n\n**Attendees:**\n\n## Agenda\n\n- \n\n## Notes\n\n## Action items\n\n- [ ] \n`,
  },
  {
    id: "decision",
    name: "Decision record",
    labels: ["decision"],
    body: (t, d) =>
      `# ${t}\n\n**Status:** Proposed\n\n**Date:** ${d}\n\n## Context\n\nWhat is the problem, and why decide it now?\n\n## Options\n\n### Option A\n\n### Option B\n\n## Decision\n\n## Consequences\n`,
  },
  {
    id: "howto",
    name: "How-to",
    labels: ["how-to"],
    body: (t) => `# ${t}\n\n{{toc}}\n\n## Before you start\n\n## Steps\n\n1. \n\n## If something goes wrong\n`,
  },
  {
    id: "overview",
    name: "Overview of a section",
    labels: [],
    body: (t) => `# ${t}\n\nWhat this part of the project is for.\n\n## Pages\n\n{{children}}\n\n## Recently changed\n\n{{recent}}\n`,
  },
];

export interface MarkdownPage {
  id: string;
  title: string;
}

/** The Markdown pages of a project (null: those without one), optionally only those with a label. */
export async function markdownPages(db: D1Database, project: string | null, label?: string): Promise<MarkdownPage[]> {
  const labeled = label ? "and a.id in (select artifact_id from labels where label = ?)" : "";
  const { results } = await db
    .prepare(
      `select a.id, a.title from artifacts a join versions v on v.artifact_id = a.id and v.version = a.current_version
       where a.deleted_at is null and a.project is ? and v.entry like '%.md' ${labeled} order by a.title`,
    )
    .bind(project, ...(label ? [label] : []))
    .all<MarkdownPage>();
  return results;
}

/** A template page's text for a new page: its first heading becomes the new title. */
export function fromTemplatePage(md: string, title: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0 && /^#\s/.test(lines[first]!)) lines[first] = `# ${title}`;
  else lines.unshift(`# ${title}`, "");
  return lines.join("\n");
}
