import type { Child } from "hono/jsx";
import { childrenOf, type TreeRow } from "../db/artifacts.ts";
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
`;

/** A page's labels, each leading to the pages with that label. */
export function LabelChips(props: { labels?: string[] }) {
  if (!props.labels?.length) return null;
  return (
    <>
      {props.labels.map((l) => (
        <a class="chip" href={`/?label=${encodeURIComponent(l)}`} title={`Pages labeled ${l}`}>
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
export function PageTree(props: { rows: TreeRow[]; current?: string; open?: Set<string>; meta?: boolean; id?: string; labels?: Map<string, string[]> }) {
  const kids = childrenOf(props.rows);
  const node = (r: TreeRow): Child => {
    const under = kids.get(r.id) ?? [];
    const row = (
      <span class={`node${r.id === props.current ? " current" : ""}`} data-text={r.title.toLowerCase()}>
        <span class="twist" aria-hidden="true">
          {under.length ? "▶" : ""}
        </span>
        <a href={`/a/${r.id}`} aria-current={r.id === props.current ? "page" : undefined}>
          {r.title}
        </a>
        <LabelChips labels={props.labels?.get(r.id)} />
        {props.meta && (
          <span class="meta">
            v{r.current_version} · <Time iso={r.updated_at} />
          </span>
        )}
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
