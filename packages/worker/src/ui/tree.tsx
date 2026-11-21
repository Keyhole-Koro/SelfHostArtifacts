import type { Child } from "hono/jsx";
import { HOME_LABEL, childrenOf, type TreeRow } from "../db/artifacts.ts";
import { Time } from "./layout.tsx";

/** The pages of a project as a tree: in the list (with versions and times) and beside a page. */
export const TREE_STYLES = `
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { padding-left: var(--space-4); border-left: 1px solid var(--border); margin-left: 7px; }
.tree li { margin: 0; }
.tree details > summary { list-style: none; cursor: pointer; }
.tree details > summary::-webkit-details-marker { display: none; }
.tree .node { display: flex; align-items: baseline; gap: var(--space-2); padding: 3px var(--space-2); border-radius: var(--radius-sm); min-width: 0; }
.tree .node:hover { background: var(--surface-2); }
.tree .twist { width: 14px; flex-shrink: 0; color: var(--text-3, var(--text-2)); font-size: 10px; text-align: center; }
.tree details[open] > summary .twist { transform: rotate(90deg); }
.tree .node a { color: var(--text); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.tree .node a:hover { text-decoration: underline; }
.tree .node.current { background: var(--accent-soft); }
.tree .node.current a { color: var(--accent); font-weight: 600; }
.tree .meta { color: var(--text-2); font-size: var(--text-xs); white-space: nowrap; font-variant-numeric: tabular-nums; }
.chip { display: inline-block; font-size: var(--text-xs); line-height: 1.6; padding: 0 var(--space-2); border-radius: 999px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; text-decoration: none; }
a.chip:hover { color: var(--accent); background: var(--accent-soft); text-decoration: none; }
.chip.current { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tree .node .chip { flex: none; }
.tree .lock { color: var(--text-2); flex: none; display: inline-flex; }
.tree .node .desc { display: block; flex-basis: 100%; color: var(--text-2); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: calc(14px + var(--space-2)); }
.tree .node.wrap { flex-wrap: wrap; row-gap: 0; }
.tree .threads { flex: none; color: var(--text-2); font-size: var(--text-xs); display: inline-flex; align-items: center; gap: 2px; }
@media (max-width: 560px) { .tree .meta, .tree .node .chip { display: none; } }
`;

/**
 * A page's labels, each leading to the pages with that label (in the same project when one is
 * given). The label that marks a project's front page is left out: being the front says it.
 */
export function LabelChips(props: { labels?: string[]; project?: string | null }) {
  const labels = props.labels?.filter((l) => l !== HOME_LABEL);
  if (!labels?.length) return null;
  const within = props.project ? `&project=${encodeURIComponent(props.project)}` : "";
  return (
    <>
      {labels.map((l) => (
        <a class="chip" href={`/?label=${encodeURIComponent(l)}${within}`} title={`Pages labeled ${l}`}>
          {l}
        </a>
      ))}
    </>
  );
}

/**
 * `open`: the pages whose children show (the rest fold); undefined opens all. `meta` adds the
 * version and the time of the last change to each page.
 */
export function PageTree(props: {
  rows: TreeRow[];
  current?: string;
  open?: Set<string>;
  meta?: boolean;
  id?: string;
  labels?: Map<string, string[]>;
  threads?: Map<string, number>;
  project?: string | null;
}) {
  const kids = childrenOf(props.rows);
  const node = (r: TreeRow): Child => {
    const under = kids.get(r.id) ?? [];
    const threads = props.threads?.get(r.id) ?? 0;
    const desc = props.meta && r.description ? r.description : "";
    const row = (
      <span class={`node${r.id === props.current ? " current" : ""}${desc ? " wrap" : ""}`} data-text={`${r.title} ${r.description ?? ""}`.toLowerCase()}>
        <span class="twist" aria-hidden="true">
          {under.length ? "▶" : ""}
        </span>
        <a href={`/a/${r.id}`} aria-current={r.id === props.current ? "page" : undefined} title={r.title}>
          {r.title}
        </a>
        {r.restriction && (
          <span class="lock" title={r.restriction === "view" ? "Only some people can view this page" : "Only some people can edit this page"}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </span>
        )}
        {threads > 0 && (
          <span class="threads" title={`${threads} open comment ${threads === 1 ? "thread" : "threads"}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            {threads}
          </span>
        )}
        <LabelChips labels={props.labels?.get(r.id)} project={props.project} />
        {props.meta && (
          <span class="meta">
            <Time iso={r.updated_at} />
          </span>
        )}
        {desc && <span class="desc">{desc}</span>}
      </span>
    );
    if (!under.length) return <li>{row}</li>;
    return (
      <li>
        <details open={props.open ? props.open.has(r.id) : true}>
          <summary>{row}</summary>
          <ul>{under.map(node)}</ul>
        </details>
      </li>
    );
  };
  return (
    <ul class="tree" id={props.id}>
      {(kids.get(null) ?? []).map(node)}
    </ul>
  );
}
