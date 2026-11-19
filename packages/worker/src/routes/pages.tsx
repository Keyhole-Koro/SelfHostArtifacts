import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../app-env.ts";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { passkeyLabel, registrationOptions, takeCeremony, verifyRegistration } from "../auth/passkeys.ts";
import { requireSameOriginForm, requireSameOriginJson, requireViewer } from "../auth/session.ts";
import { SANDBOX_FLAGS, mintContentToken } from "../content.ts";
import { listRecentAuditEvents, recordAuditEvent } from "../db/audit.ts";
import {
  ancestorsOf,
  getArtifact,
  getVersion,
  listArtifacts,
  listProjectPages,
  placeAmongSiblings,
  setParent,
  siblingsOf,
  subtreeOf,
  listConnecting,
  listProjects,
  listTrash,
  listVersions,
  restoreArtifact,
  revokeConnect,
  clearShare,
  setProject,
  setShare,
  type ArtifactRow,
  type TreeRow,
} from "../db/artifacts.ts";
import { projectSchema } from "@artifact/shared";
import { SHARE_DAYS, newShareNonce, shareActive, shareExpiry, shareKey, shareKeyValid, sharePath } from "../share.ts";
import {
  INVITE_DAYS,
  createInvite,
  createLoginLink,
  deleteUser,
  getUser,
  insertPasskey,
  listOpenInvites,
  listPasskeys,
  listUsers,
} from "../db/users.ts";
import { randomId } from "../lib/encoding.ts";
import { finishSecret, listSecrets, secretOpen, secretStatus } from "../db/secrets.ts";
import { renderSVG } from "uqr";
import { pageSecurity } from "../ui/security.ts";
import { CsrfField, Page, TOKENS, Time, formatTime } from "../ui/layout.tsx";
import { PageTree, TREE_STYLES } from "../ui/tree.tsx";
import { canEditProject, canSeeProject, getSpace, hiddenProjects } from "../db/spaces.ts";

export const pages = new Hono<AppEnv>();

const SECRET_STATUS_LABEL = {
  waiting: "Not opened",
  claimed: "Opened",
  sealed: "Sent",
  received: "Received",
  deleted: "Deleted",
  expired: "Expired",
} as const;

pages.use(pageSecurity);

function recordViewerAction(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId?: string | null,
  metadata?: Record<string, string | number | boolean | null>,
) {
  const viewer = c.get("viewer");
  return recordAuditEvent(c, {
    actorType: "user",
    actorId: viewer.userId,
    actorLabel: viewer.name,
    action,
    targetType,
    targetId,
    metadata,
  });
}

// --- List ---

const PROJECT_STYLES = `
.projects { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0 0 var(--space-4); }
.projects a { display: inline-flex; align-items: baseline; gap: var(--space-1); padding: 4px var(--space-3); border: 1px solid var(--border); border-radius: 999px; color: var(--text); text-decoration: none; font-size: var(--text-sm); background: var(--surface); }
.projects a:hover { background: var(--surface-2); }
.projects a.current { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.projects span { color: var(--text-2); font-variant-numeric: tabular-nums; }
.projects a.current span { color: inherit; }
`;

/** `/` lists every page; `/?project=<name>` one project; `/?project=` the pages without one. */
function projectHref(project: string | null): string {
  return `/?project=${encodeURIComponent(project ?? "")}`;
}

pages.get("/", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const query = c.req.query("project");
  const selected = query === undefined ? undefined : query.trim() || null;
  const hidden = await hiddenProjects(c.env.DB, viewer);
  const blocked = typeof selected === "string" && hidden.has(selected);
  const [all, allProjects] = await Promise.all([blocked ? [] : listArtifacts(c.env.DB, 200, selected), listProjects(c.env.DB)]);
  const artifacts = all.filter((a) => !a.project || !hidden.has(a.project));
  const projects = allProjects.filter((p) => !p.project || !hidden.has(p.project));
  // One project is shown as the tree of its pages, with what the space says about itself.
  const [tree, space] =
    typeof selected === "string" && !blocked ? await Promise.all([listProjectPages(c.env.DB, selected), getSpace(c.env.DB, selected)]) : [undefined, null];
  const total = projects.reduce((n, p) => n + p.count, 0);
  const showProjects = projects.some((p) => p.project !== null);
  const scope = selected === undefined ? "" : selected === null ? " without a project" : ` in ${selected}`;
  return c.html(
    <Page title={typeof selected === "string" ? `${selected} · Artifacts` : "Artifacts"} viewer={viewer}>
      <style>{raw(PROJECT_STYLES + TREE_STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>{typeof selected === "string" ? selected : "Artifacts"}</h1>
          <p class="lead">
            {tree ? (space?.description ?? `${tree.length} ${tree.length === 1 ? "page" : "pages"}`) : (
              <>
                {artifacts.length} {artifacts.length === 1 ? "page" : "pages"}
                {scope}, newest first
              </>
            )}
            {tree && viewer.role === "root" && (
              <>
                {" · "}
                <a href={`/projects/${encodeURIComponent(selected as string)}`}>
                  {space?.access === "members" ? "Members only" : "Everyone"} · Settings
                </a>
              </>
            )}
          </p>
        </div>
        {artifacts.length > 0 && <input id="filter" class="search" type="search" placeholder="Search" aria-label="Search titles and descriptions" />}
      </div>
      {showProjects && (
        <nav class="projects" aria-label="Projects">
          <a href="/" class={selected === undefined ? "current" : undefined}>
            All <span>{total}</span>
          </a>
          {projects.map((p) => (
            <a href={projectHref(p.project)} class={selected === p.project ? "current" : undefined}>
              {p.project ?? "No project"} <span>{p.count}</span>
            </a>
          ))}
        </nav>
      )}
      {artifacts.length === 0 && selected !== undefined ? (
        <div class="card">
          <p class="muted small" style="margin:0">
            No page here. <a href="/">Show all pages</a>
          </p>
        </div>
      ) : artifacts.length === 0 ? (
        <div class="card">
          <h2>Nothing published yet</h2>
          <p class="muted small" style="margin:var(--space-2) 0 0">
            Ask an agent for a page, for example “turn this CSV into a dashboard page”. It publishes with the <code>artifact</code> tool and
            the page appears here.
          </p>
        </div>
      ) : tree ? (
        <>
          <div class="card">
            <PageTree rows={tree} meta id="artifacts" />
            <p class="empty muted small" id="no-match" hidden>
              No page matches your search.
            </p>
          </div>
          <script nonce={c.get("nonce")}>
            {raw(`
const input = document.getElementById("filter");
const items = [...document.querySelectorAll("#artifacts li")].reverse();
const none = document.getElementById("no-match");
input.addEventListener("input", () => {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  // A page stays when it or a page under it matches; the children come first in this order.
  for (const li of items) {
    const own = li.querySelector(":scope > .node, :scope > details > summary > .node").dataset.text.includes(q);
    const below = [...li.querySelectorAll(":scope > details > ul > li")].some((x) => !x.hidden);
    li.hidden = q !== "" && !own && !below;
    if (q !== "" && !li.hidden) { const d = li.querySelector(":scope > details"); if (d) d.open = true; }
    if (!li.hidden) shown++;
  }
  none.hidden = shown > 0;
});`)}
          </script>
        </>
      ) : (
        <>
          <ul class="rows links" id="artifacts">
            {artifacts.map((a) => (
              <li data-text={`${a.title} ${a.description ?? ""} ${a.project ?? ""}`.toLowerCase()}>
                <div class="main">
                  <a class="title" href={`/a/${a.id}`}>
                    {a.title}
                  </a>{" "}
                  {selected === undefined && a.project && <span class="badge">{a.project}</span>}{" "}
                  {a.allow_connect.length > 0 && (
                    <span class="badge warn" title={`May connect to ${a.allow_connect.join(", ")}`}>
                      external
                    </span>
                  )}{" "}
                  {shareActive(a) && (
                    <span class="badge accent" title={`Anyone with the link can view it until ${formatTime(a.share_expires_at)}`}>
                      public
                    </span>
                  )}
                  {a.description && <div class="desc">{a.description}</div>}
                </div>
                <div class="side">
                  <span>v{a.current_version}</span>
                  <Time iso={a.updated_at} />
                </div>
              </li>
            ))}
            <li class="empty" id="no-match" hidden>
              No page matches your search.
            </li>
          </ul>
          <script nonce={c.get("nonce")}>
            {raw(`
const input = document.getElementById("filter");
const items = [...document.querySelectorAll("#artifacts li[data-text]")];
const none = document.getElementById("no-match");
input.addEventListener("input", () => {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const li of items) { li.hidden = q !== "" && !li.dataset.text.includes(q); if (!li.hidden) shown++; }
  none.hidden = shown > 0;
});`)}
          </script>
        </>
      )}
    </Page>,
  );
});

// --- Viewer ---

const VIEWER_STYLES = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 400 var(--text-sm)/1.4 var(--font-sans); }
a { color: inherit; text-decoration: none; }
.bar { height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-3); border-bottom: 1px solid var(--border); background: var(--bg); }
.back { display: flex; align-items: center; gap: var(--space-1); color: var(--text-2); padding: 4px var(--space-2); border-radius: var(--radius-sm); }
.back:hover { background: var(--surface-2); color: var(--text); }
.divider { width: 1px; height: 18px; background: var(--border); }
.title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.meta { color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.old { color: var(--warning); }
.badge { font-size: var(--text-xs); font-weight: 600; padding: 1px var(--space-2); border-radius: 999px; background: color-mix(in srgb, var(--warning) 14%, var(--surface)); color: var(--warning); white-space: nowrap; }
.spacer { flex: 1; }
.tool { display: flex; align-items: center; gap: var(--space-1); color: var(--text-2); padding: 4px var(--space-2); border-radius: var(--radius-sm); cursor: pointer; white-space: nowrap; }
.tool:hover { background: var(--surface-2); color: var(--text); }
details { position: relative; }
summary { list-style: none; }
summary::-webkit-details-marker { display: none; }
.panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 2; min-width: 240px; max-height: 60vh; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); padding: var(--space-1); }
.panel a { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); color: var(--text); font-variant-numeric: tabular-nums; }
.panel a:hover { background: var(--surface-2); }
.panel a.current { font-weight: 600; background: var(--accent-soft); color: var(--accent); }
.panel span { color: var(--text-2); }
iframe { flex: 1; width: 100%; min-width: 0; border: 0; background: #fff; }
.main { flex: 1; display: flex; min-height: 0; }
.side { display: none; width: 268px; flex-shrink: 0; overflow: auto; border-right: 1px solid var(--border); background: var(--surface); padding: var(--space-2); }
body.with-side .side { display: block; }
.side h2 { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); margin: var(--space-2) var(--space-2) var(--space-2); }
.side h2 a:hover { color: var(--text); text-decoration: underline; }
.crumbs { display: flex; align-items: baseline; gap: var(--space-1); min-width: 0; overflow: hidden; }
.crumbs a { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
.crumbs a:hover { color: var(--text); text-decoration: underline; }
.crumbs .sep { color: var(--text-2); }
.move { width: min(380px, calc(100vw - 24px)); }
.move select { flex: 1; min-width: 0; font: inherit; padding: 4px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.move h3 { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
.short { display: none; }
.share { width: min(360px, calc(100vw - 24px)); padding: var(--space-3); display: grid; gap: var(--space-2); }
.share p { margin: 0; color: var(--text-2); }
.share .link { display: flex; gap: var(--space-2); }
.share input { flex: 1; min-width: 0; font: inherit; font-size: var(--text-xs); padding: 4px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.share .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.share form { margin: 0; }
.share button { font: inherit; padding: 4px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; }
.share button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text, #fff); }
.share button.danger { color: var(--negative, #c0362c); }
.badge.public { background: var(--accent-soft); color: var(--accent); }
@media (max-width: 640px) {
  .meta, .label, .divider, .crumbs a, .crumbs .sep { display: none; }
  body.with-side .side { position: fixed; top: 44px; bottom: 0; left: 0; z-index: 3; width: min(300px, 85vw); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
  .panel.share { position: fixed; top: 50px; left: 12px; right: 12px; width: auto; }
  .short { display: inline; }
}
`;

async function viewerPage(c: Context<AppEnv>, id: string, requested: number | undefined) {
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  // A page in a space the viewer is not let into is answered like a page that does not exist.
  if (!artifact || !(await canSeeProject(c.env.DB, viewer, artifact.project))) return c.notFound();
  const versionNumber = requested ?? artifact.current_version;
  const version = await getVersion(c.env.DB, id, versionNumber);
  if (!version) return c.notFound();
  const versions = await listVersions(c.env.DB, id);
  const tree = artifact.project ? await listProjectPages(c.env.DB, artifact.project) : undefined;
  const trail = tree ? ancestorsOf(tree, id) : [];
  const editor = viewer.role !== "root" && viewer.sessionKind === "full" && (await canEditProject(c.env.DB, viewer, artifact.project));
  const projects = viewer.role === "root" ? await listProjects(c.env.DB) : [];
  const shareUrl = shareActive(artifact)
    ? `${c.get("config").origin}${sharePath(id, await shareKey(c.env.CONTENT_TOKEN_SECRET, id, artifact.share_nonce))}`
    : undefined;
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, versionNumber);
  const src = `/c/${token}/${encodeURI(version.entry)}`;
  const nonce = c.get("nonce");
  const isLatest = versionNumber === artifact.current_version;
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{artifact.title}</title>
        <style>{raw(TOKENS + VIEWER_STYLES + TREE_STYLES)}</style>
      </head>
      <body>
        {tree && (
          <script nonce={nonce}>
            {raw(`(() => { let on = null; try { on = localStorage.getItem("artifact.side"); } catch {}
  if (on === null ? window.innerWidth >= 900 : on === "1") document.body.classList.add("with-side"); })();`)}
          </script>
        )}
        <div class="bar">
          {tree && (
            <button type="button" id="side-toggle" class="tool" aria-controls="side" title="Pages in this project" style="border:0;background:none;font:inherit">
              ☰
            </button>
          )}
          <a href={artifact.project ? projectHref(artifact.project) : "/"} class="back" aria-label={artifact.project ? `Pages in ${artifact.project}` : "All artifacts"}>
            ← <span class="label">{artifact.project ?? "Artifacts"}</span>
          </a>
          <span class="divider" aria-hidden="true" />
          <nav class="crumbs" aria-label="Where this page is">
            {trail.map((t) => (
              <>
                <a href={`/a/${t.id}`}>{t.title}</a>
                <span class="sep" aria-hidden="true">
                  ›
                </span>
              </>
            ))}
            <span class="title">{artifact.title}</span>
          </nav>
          <span class="meta">
            {isLatest ? `v${versionNumber}` : <span class="old">v{versionNumber} (latest is v{artifact.current_version})</span>} ·{" "}
            <Time iso={version.created_at} />
          </span>
          {version.allow_connect.length > 0 && (
            <span class="badge" title={`May connect to ${version.allow_connect.join(", ")}`}>
              external
            </span>
          )}
          {shareUrl && <span class="badge public">public</span>}
          <span class="spacer" />
          {(viewer.role === "root" || editor) && (
            <MovePanel
              id={id}
              project={artifact.project}
              projects={viewer.role === "root" ? projects.flatMap((p) => (p.project ? [p.project] : [])) : undefined}
              csrf={viewer.csrf}
              tree={tree}
              parent={artifact.parent}
            />
          )}
          {viewer.role === "root" && (
            <SharePanel id={id} artifact={artifact} shareUrl={shareUrl} csrf={viewer.csrf} open={c.req.query("share") === "1"} />
          )}
          <details>
            <summary class="tool">
              <span class="label">Versions</span>
              <span class="short">v{versionNumber}</span> ▾
            </summary>
            <div class="panel">
              {versions.map((v) => (
                <a href={v.version === artifact.current_version ? `/a/${id}` : `/a/${id}/v/${v.version}`} class={v.version === versionNumber ? "current" : ""}>
                  v{v.version}
                  {v.version === artifact.current_version && " · latest"}
                  <span>
                    <Time iso={v.created_at} />
                  </span>
                </a>
              ))}
            </div>
          </details>
          <a id="open" href={src} target="_blank" rel="noopener noreferrer" class="tool" title="Open in a new tab">
            ↗ <span class="label">Open</span>
          </a>
        </div>
        <div class="main">
          {tree && (
            <nav id="side" class="side" aria-label={`Pages in ${artifact.project}`}>
              <h2>
                <a href={projectHref(artifact.project)}>{artifact.project}</a>
              </h2>
              <PageTree rows={tree} current={id} open={new Set([...trail.map((t) => t.id), id])} />
            </nav>
          )}
          <iframe id="frame" src={src} sandbox={SANDBOX_FLAGS} title={artifact.title} />
        </div>
        <script nonce={nonce}>
          {raw(`
const toggle = document.getElementById("side-toggle");
if (toggle) {
  const sync = () => toggle.setAttribute("aria-expanded", String(document.body.classList.contains("with-side")));
  sync();
  toggle.addEventListener("click", () => {
    const on = document.body.classList.toggle("with-side");
    try { localStorage.setItem("artifact.side", on ? "1" : "0"); } catch {}
    sync();
  });
}
let exp = ${exp};
const tokenUrl = ${JSON.stringify(`/a/${id}/token?v=${versionNumber}`)};
async function refresh() {
  if (Date.now() / 1000 < exp - 120) return;
  const res = await fetch(tokenUrl, { credentials: "same-origin" });
  if (!res.ok) return;
  const next = await res.json();
  exp = next.exp;
  document.getElementById("frame").src = next.src;
  document.getElementById("open").href = next.src;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);
const copy = document.getElementById("share-copy");
if (copy) copy.addEventListener("click", async () => {
  const input = document.getElementById("share-url");
  try { await navigator.clipboard.writeText(input.value); copy.textContent = "Copied"; }
  catch { input.select(); copy.textContent = "Selected"; }
  setTimeout(() => { copy.textContent = "Copy"; }, 1500);
});`)}
        </script>
      </body>
    </html>,
  );
}

function daysLeft(iso: string): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 864e5);
  return days <= 1 ? "less than a day left" : `${days} days left`;
}

function SharePanel(props: { id: string; artifact: ArtifactRow; shareUrl: string | undefined; csrf: string; open: boolean }) {
  const { id, artifact, shareUrl, csrf } = props;
  const action = (path: string, label: string, cls = "") => (
    <form method="post" action={`/a/${id}/share${path}`}>
      <CsrfField token={csrf} />
      <button type="submit" class={cls || undefined}>
        {label}
      </button>
    </form>
  );
  return (
    <details open={props.open}>
      <summary class="tool">
        <span class="label">Share</span>
        <span class="short">⤴</span> ▾
      </summary>
      <div class="panel share">
        {shareUrl ? (
          <>
            <p>Anyone with this link can view the latest version without signing in.</p>
            <div class="link">
              <input id="share-url" type="text" readonly value={shareUrl} aria-label="Public link" />
              <button type="button" id="share-copy">
                Copy
              </button>
            </div>
            <p>
              Open until <time datetime={artifact.share_expires_at!}>{formatTime(artifact.share_expires_at!)}</time> ({daysLeft(artifact.share_expires_at!)}).
            </p>
            <div class="actions">
              {action("", `Extend ${SHARE_DAYS} days`)}
              {action("/reset", "New link")}
              {action("/off", "Turn off", "danger")}
            </div>
          </>
        ) : (
          <>
            <p>
              Create a link that anyone can open without signing in, for {SHARE_DAYS} days. They see the latest version only, not the list or
              older versions.
            </p>
            <div class="actions">{action("", "Create public link", "primary")}</div>
          </>
        )}
      </div>
    </details>
  );
}

/** Moves the page to another project. Shares the share panel's look. */
/** The pages a page can go under: everything in its project but itself and the pages below it, indented by depth. */
function parentChoices(tree: TreeRow[], id: string): { id: string; label: string }[] {
  const below = subtreeOf(tree, id), out: { id: string; label: string }[] = [];
  const walk = (rows: TreeRow[], depth: number) => {
    for (const r of rows) {
      if (below.has(r.id)) continue;
      out.push({ id: r.id, label: `${"\u00a0\u00a0\u00a0".repeat(depth)}${r.title}` });
      walk(tree.filter((x) => x.parent === r.id), depth + 1);
    }
  };
  const ids = new Set(tree.map((r) => r.id));
  walk(tree.filter((r) => !r.parent || !ids.has(r.parent)), 0);
  return out;
}

/** `projects`: the owner's choice of projects; an editor (without it) only moves pages within the project. */
function MovePanel(props: { id: string; project: string | null; projects?: string[]; csrf: string; tree?: TreeRow[]; parent: string | null }) {
  const { id, project, projects, csrf, tree } = props;
  const siblings = tree ? siblingsOf(tree, id) : [];
  const place = siblings.findIndex((r) => r.id === id);
  return (
    <details>
      <summary class="tool">
        <span class="label">Move</span>
        <span class="short">▤</span> ▾
      </summary>
      <div class="panel share move">
        {tree && (
          <>
            <h3>Place in {project}</h3>
            <form method="post" action={`/a/${id}/parent`} class="link">
              <CsrfField token={csrf} />
              <select name="parent" aria-label="Put this page under">
                <option value="" selected={!props.parent}>
                  At the top
                </option>
                {parentChoices(tree, id).map((o) => (
                  <option value={o.id} selected={o.id === props.parent}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="submit" class="primary">
                Put under
              </button>
            </form>
            {siblings.length > 1 && (
              <div class="actions">
                {(["up", "down"] as const).map((dir) => (
                  <form method="post" action={`/a/${id}/order`}>
                    <CsrfField token={csrf} />
                    <input type="hidden" name="dir" value={dir} />
                    <button type="submit" disabled={dir === "up" ? place <= 0 : place >= siblings.length - 1}>
                      {dir === "up" ? "↑ Earlier" : "↓ Later"}
                    </button>
                  </form>
                ))}
              </div>
            )}
            {projects && <h3>Project</h3>}
          </>
        )}
        {projects && <ProjectMove id={id} project={project} projects={projects} csrf={csrf} />}
      </div>
    </details>
  );
}

function ProjectMove(props: { id: string; project: string | null; projects: string[]; csrf: string }) {
  const { id, project, projects, csrf } = props;
  return (
    <>
        <p>{project ? `In ${project}, with the pages under it. Move them to another project:` : "Not in a project. Put it in one:"}</p>
        <form method="post" action={`/a/${id}/project`} class="link">
          <CsrfField token={csrf} />
          <input name="project" type="text" list="project-names" required maxlength={60} value={project ?? ""} aria-label="Project" />
          <datalist id="project-names">
            {projects.map((p) => (
              <option value={p} />
            ))}
          </datalist>
          <button type="submit" class="primary">
            Move
          </button>
        </form>
        {project && (
          <div class="actions">
            <form method="post" action={`/a/${id}/project`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="project" value="" />
              <button type="submit">Remove from {project}</button>
            </form>
          </div>
        )}
    </>
  );
}

pages.get("/a/:id", requireViewer(), (c) => viewerPage(c, c.req.param("id"), undefined));

pages.get("/a/:id/v/:version{[0-9]+}", requireViewer(), (c) => viewerPage(c, c.req.param("id"), Number(c.req.param("version"))));

/** A fresh content URL for the viewer page, before its token expires. */
pages.get("/a/:id/token", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeeProject(c.env.DB, c.get("viewer"), artifact.project))) return c.json({ error: "not found" }, 404);
  const version = await getVersion(c.env.DB, id, Number(c.req.query("v") ?? artifact.current_version));
  if (!version) return c.json({ error: "not found" }, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version);
  return c.json({ src: `/c/${token}/${encodeURI(version.entry)}`, exp });
});

// --- Public links (owner turns them on; anyone with the link views) ---

async function shareAction(c: Context<AppEnv>, mode: "open" | "reset" | "off") {
  const id = c.req.param("id")!;
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact) return c.notFound();
  const expiresAt = shareExpiry();
  if (mode === "off") {
    await clearShare(c.env.DB, id);
    await recordViewerAction(c, "share.disable", "artifact", id);
  } else {
    // "open" keeps a live link's URL and only moves its expiry; otherwise a new URL is made.
    const keep = mode === "open" && shareActive(artifact);
    await setShare(c.env.DB, id, keep ? artifact.share_nonce! : newShareNonce(), expiresAt);
    await recordViewerAction(c, keep ? "share.extend" : mode === "reset" ? "share.reset" : "share.enable", "artifact", id, { expires_at: expiresAt });
  }
  return c.redirect(`/a/${id}?share=1`, 303);
}

// Middleware per route, not `use` on a sub-app: mounted at "/", that would also guard /s/*.
const ownerForm = [requireViewer("root", true), requireSameOriginForm()] as const;

pages.post("/a/:id/project", ...ownerForm, async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const name = typeof form["project"] === "string" ? form["project"].trim() : "";
  const parsed = name === "" ? { success: true as const, data: null } : projectSchema.safeParse(name);
  if (!parsed.success) return c.text("A project name is one line of at most 60 characters, without slashes.", 400);
  if (!(await setProject(c.env.DB, id, parsed.data))) return c.notFound();
  await recordViewerAction(c, "artifact.move", "artifact", id, { project: parsed.data });
  return c.redirect(`/a/${id}`, 303);
});
// The owner, and the editors of the page's project, rearrange its pages.
const editorForm = [requireViewer("viewer", true), requireSameOriginForm()] as const;

async function editable(c: Context<AppEnv>, id: string): Promise<ArtifactRow | Response> {
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  if (!artifact || !(await canSeeProject(c.env.DB, viewer, artifact.project))) return c.notFound();
  if (!(await canEditProject(c.env.DB, viewer, artifact.project))) return c.text("Only the owner and this project's editors can move its pages.", 403);
  return artifact;
}

/** Puts a page under another page of its project (empty: at the top). */
pages.post("/a/:id/parent", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const form = await c.req.parseBody();
  const parent = typeof form["parent"] === "string" && form["parent"] !== "" ? form["parent"] : null;
  const tree = await listProjectPages(c.env.DB, artifact.project);
  if (parent && (!tree.some((r) => r.id === parent) || subtreeOf(tree, id).has(parent))) {
    return c.text("That page cannot hold this one: it is not in the same project, or it is this page or below it.", 400);
  }
  if (parent !== artifact.parent) await setParent(c.env.DB, id, parent);
  await recordViewerAction(c, "artifact.move", "artifact", id, { parent });
  return c.redirect(`/a/${id}`, 303);
});

/** Moves a page one place earlier or later among the pages with the same parent. */
pages.post("/a/:id/order", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const form = await c.req.parseBody();
  const tree = await listProjectPages(c.env.DB, artifact.project);
  const at = siblingsOf(tree, id).findIndex((r) => r.id === id);
  await placeAmongSiblings(c.env.DB, tree, id, at + 1 + (form["dir"] === "up" ? -1 : 1));
  return c.redirect(`/a/${id}`, 303);
});

pages.post("/a/:id/share", ...ownerForm, (c) => shareAction(c, "open"));
pages.post("/a/:id/share/reset", ...ownerForm, (c) => shareAction(c, "reset"));
pages.post("/a/:id/share/off", ...ownerForm, (c) => shareAction(c, "off"));

/** Looks up a live public link; undefined for a wrong key, a turned-off or expired link, or a deleted artifact. */
async function sharedArtifact(c: Context<AppEnv>) {
  const artifact = await getArtifact(c.env.DB, c.req.param("id")!);
  if (!artifact || !(await shareKeyValid(c.env.CONTENT_TOKEN_SECRET, artifact, c.req.param("key")!))) return undefined;
  return artifact as ArtifactRow & { share_nonce: string; share_expires_at: string };
}

function noIndex(c: Context<AppEnv>) {
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
}

const LINK_GONE = "This link has expired or was turned off. Ask the person who sent it for a new one.";

pages.get("/s/:id/:key", async (c) => {
  noIndex(c);
  const artifact = await sharedArtifact(c);
  if (!artifact) return c.text(LINK_GONE, 404);
  const version = await getVersion(c.env.DB, artifact.id, artifact.current_version);
  if (!version) return c.text(LINK_GONE, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, artifact.id, version.version, artifact.share_nonce);
  const src = `/c/${token}/${encodeURI(version.entry)}`;
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{artifact.title}</title>
        <style>{raw(TOKENS + VIEWER_STYLES)}</style>
      </head>
      <body>
        <div class="bar">
          <span class="title">{artifact.title}</span>
          <span class="meta">
            Updated <Time iso={version.created_at} />
          </span>
          <span class="spacer" />
          <a id="open" href={src} target="_blank" rel="noopener noreferrer" class="tool" title="Open in a new tab">
            ↗ <span class="label">Open</span>
          </a>
        </div>
        <iframe id="frame" src={src} sandbox={SANDBOX_FLAGS} title={artifact.title} />
        <script nonce={c.get("nonce")}>
          {raw(`
let exp = ${exp};
const tokenUrl = location.pathname + "/token";
async function refresh() {
  if (Date.now() / 1000 < exp - 120) return;
  const res = await fetch(tokenUrl, { credentials: "omit" });
  if (!res.ok) return;
  const next = await res.json();
  exp = next.exp;
  document.getElementById("frame").src = next.src;
  document.getElementById("open").href = next.src;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);`)}
        </script>
      </body>
    </html>,
  );
});

pages.get("/s/:id/:key/token", async (c) => {
  noIndex(c);
  const artifact = await sharedArtifact(c);
  if (!artifact) return c.json({ error: LINK_GONE }, 404);
  const version = await getVersion(c.env.DB, artifact.id, artifact.current_version);
  if (!version) return c.json({ error: LINK_GONE }, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, artifact.id, version.version, artifact.share_nonce);
  return c.json({ src: `/c/${token}/${encodeURI(version.entry)}`, exp });
});

// --- Account (everyone): your passkeys ---

const account = new Hono<AppEnv>();
// A paired-device login may browse artifacts, but account changes require a passkey-backed session.
account.use(requireViewer("viewer", true));

account.get("/account", async (c) => {
  const viewer = c.get("viewer");
  const passkeys = await listPasskeys(c.env.DB, viewer.userId);
  return c.html(
    <Page title="Account" viewer={viewer} passkeys>
      <div class="page-head">
        <div>
          <h1>Account</h1>
          <p class="lead">{viewer.role === "root" ? "Owner of this site" : "Viewer"}</p>
        </div>
      </div>

      <section class="section" id="name">
        <div class="section-head">
          <div>
            <h2>Name</h2>
            <p>Shown in the menu and to the owner in Settings.</p>
          </div>
        </div>
        <form method="post" action="/account/name" class="field-row">
          <CsrfField token={viewer.csrf} />
          <input type="text" name="name" required maxlength={64} value={viewer.name} aria-label="Name" autocomplete="name" />
          <button type="submit">Save</button>
        </form>
      </section>

      <section class="section" id="sessions">
        <div class="section-head">
          <div>
            <h2>Signed-in browsers</h2>
            <p>End every other browser session if a device was lost or an account may have been accessed.</p>
          </div>
          <form method="post" action="/account/sessions/revoke-others">
            <CsrfField token={viewer.csrf} />
            <button class="danger" type="submit">Sign out other browsers</button>
          </form>
        </div>
      </section>

      <section class="section" id="passkeys">
        <div class="section-head">
          <div>
            <h2>Passkeys</h2>
            <p>Each passkey signs you in from the device or password manager that holds it. Synced passkeys follow you to your other devices.</p>
          </div>
          <button type="button" data-passkey="register" data-options="/account/passkeys/options" data-verify="/account/passkeys/verify">
            Add a passkey
          </button>
        </div>
        <ul class="rows">
          {passkeys.length === 0 && <li class="empty">No passkeys yet. Add one to sign in without the CLI.</li>}
          {passkeys.map((p) => (
            <li>
              <div class="main">
                <div class="title">{p.label}</div>
                <div class="desc">
                  Added <Time iso={p.created_at} />
                  {p.last_used_at && (
                    <>
                      {" · last used "}
                      <Time iso={p.last_used_at} />
                    </>
                  )}
                </div>
              </div>
              <div class="side">
                {passkeys.length > 1 && (
                  <form class="inline" method="post" action={`/account/passkeys/${encodeURIComponent(p.id)}/remove`}>
                    <CsrfField token={viewer.csrf} />
                    <button class="danger" type="submit">
                      Remove
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="section" id="phone">
        <div class="section-head">
          <div>
            <h2>Sign in on your phone</h2>
            <p>Shows a QR code that signs your phone in as you. It works once, for two minutes; then add a passkey on the phone.</p>
          </div>
          <form method="post" action="/account/phone-link">
            <CsrfField token={viewer.csrf} />
            <button type="submit">Show QR code</button>
          </form>
        </div>
      </section>
    </Page>,
  );
});

account.post("/account/passkeys/options", requireSameOriginJson(), async (c) => {
  const viewer = c.get("viewer");
  return c.json(await registrationOptions(c, { id: viewer.userId, name: viewer.name }));
});

account.post("/account/passkeys/verify", requireSameOriginJson(), async (c) => {
  const viewer = c.get("viewer");
  const ceremony = await takeCeremony(c);
  if (ceremony?.kind !== "register" || ceremony.userId !== viewer.userId || ceremony.inviteHash) {
    return c.json({ error: "The request took too long. Try again." }, 400);
  }
  const { response } = (await c.req.json()) as { response: RegistrationResponseJSON };
  const passkey = await verifyRegistration(c, ceremony, response);
  if (!passkey) return c.json({ error: "The passkey could not be verified." }, 400);
  await insertPasskey(c.env.DB, {
    id: passkey.id,
    userId: viewer.userId,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    transports: passkey.transports,
    label: passkeyLabel(c.req.header("user-agent")),
  }).run();
  await recordViewerAction(c, "passkey.add", "user", viewer.userId, { label: passkeyLabel(c.req.header("user-agent")) });
  return c.json({ next: "/account#passkeys" });
});

account.post("/account/phone-link", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const token = await createLoginLink(c.env.DB, viewer.userId, "/account#passkeys", "full");
  await recordViewerAction(c, "auth.phone_link_create", "user", viewer.userId);
  const url = `${c.get("config").origin}/auth/link/${token}`;
  // Dark modules on white whatever the theme: phone cameras read that most reliably.
  const qr = renderSVG(url, { border: 2, pixelSize: 6, whiteColor: "#ffffff", blackColor: "#000000" });
  return c.html(
    <Page title="Sign in on your phone" viewer={viewer}>
      <div class="narrow">
        <h1>Scan with your phone</h1>
        <p class="muted small">Point the camera at the code and open the link. It signs in as {viewer.name}, works once and expires in two minutes.</p>
        <div class="qr" role="img" aria-label="QR code with a one-time sign-in link">
          {raw(qr)}
        </div>
        <details>
          <summary class="muted small">Show the link instead</summary>
          <p class="link-box">{url}</p>
        </details>
        <p style="margin-top:var(--space-5)">
          <a href="/account">← Back to your account</a>
        </p>
      </div>
    </Page>,
  );
});

account.post("/account/name", requireSameOriginForm(), async (c) => {
  const name = String((await c.req.parseBody())["name"] ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 64) return c.text("A name is 1 to 64 characters.", 400);
  await c.env.DB.prepare("update users set name = ? where id = ?").bind(name, c.get("viewer").userId).run();
  await recordViewerAction(c, "user.name_update", "user", c.get("viewer").userId);
  return c.redirect("/account", 303);
});

account.post("/account/passkeys/:id/remove", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const passkeys = await listPasskeys(c.env.DB, viewer.userId);
  if (passkeys.length <= 1) return c.text("Add another passkey before removing your last one.", 400);
  await c.env.DB.batch([
    c.env.DB.prepare("delete from passkeys where id = ? and user_id = ?").bind(c.req.param("id"), viewer.userId),
    // Sessions are not tied to a particular credential. Keep this verified browser and end every
    // other session so removing a compromised passkey also removes sessions it may have created.
    c.env.DB.prepare("delete from sessions where user_id = ? and id <> ?").bind(viewer.userId, viewer.sessionId),
  ]);
  await recordViewerAction(c, "passkey.remove", "user", viewer.userId, { otherSessionsRevoked: true });
  return c.redirect("/account#passkeys", 303);
});

account.post("/account/sessions/revoke-others", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const revoked = await c.env.DB.prepare("delete from sessions where user_id = ? and id <> ?").bind(viewer.userId, viewer.sessionId).run();
  await recordViewerAction(c, "session.revoke_others", "user", viewer.userId, { count: revoked.meta.changes ?? 0 });
  return c.redirect("/account#sessions", 303);
});

pages.route("/", account);

// --- Settings (root only) ---

const root = new Hono<AppEnv>();
// Owner operations require a passkey-backed session; a stolen publisher key is not enough.
root.use(requireViewer("root", true));

root.get("/settings", async (c) => {
  const viewer = c.get("viewer");
  const [users, invitesOpen, devices, connecting, trash, auditEvents, secrets] = await Promise.all([
    listUsers(c.env.DB),
    listOpenInvites(c.env.DB),
    c.env.DB.prepare("select id, name, created_at, last_used_at from devices where revoked_at is null order by created_at desc").all<{
      id: string;
      name: string;
      created_at: string;
      last_used_at: string | null;
    }>(),
    listConnecting(c.env.DB),
    listTrash(c.env.DB),
    listRecentAuditEvents(c.env.DB, 50),
    listSecrets(c.env.DB, 50),
  ]);
  const trashDays = c.get("config").trashDays;
  return c.html(
    <Page title="Settings" viewer={viewer}>
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p class="lead">Who can see this site, which computers can publish, and what was deleted.</p>
        </div>
      </div>

      <section class="section" id="people">
        <div class="section-head">
          <div>
            <h2>People</h2>
            <p>Viewers can open every artifact. Invite someone with a link; they create a passkey when they open it.</p>
          </div>
          <form method="post" action="/settings/invites">
            <CsrfField token={viewer.csrf} />
            <button class="primary" type="submit">
              Create invite link
            </button>
          </form>
        </div>
        <ul class="rows">
          {users.map((u) => (
            <li>
              <div class="main">
                <span class="title">{u.name}</span>
                {u.id === viewer.userId && <span class="muted small"> (you)</span>}{" "}
                <span class={`badge ${u.role === "root" ? "accent" : ""}`}>{u.role === "root" ? "Owner" : "Viewer"}</span>
                <div class="desc">
                  {u.passkeys} passkey{u.passkeys === 1 ? "" : "s"} · joined <Time iso={u.created_at} />
                </div>
              </div>
              <div class="side">
                {u.id !== viewer.userId && (
                  <form class="inline" method="post" action={`/settings/users/${u.id}/remove`}>
                    <CsrfField token={viewer.csrf} />
                    <button class="danger" type="submit">
                      Remove
                    </button>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
        {invitesOpen.length > 0 && (
          <div class="field-row" style="align-items:center;margin-top:var(--space-3)">
            <span class="muted small" style="flex:1">
              {invitesOpen.length} invite link{invitesOpen.length === 1 ? " is" : "s are"} not used yet.
            </span>
            <form class="inline" method="post" action="/settings/invites/revoke">
              <CsrfField token={viewer.csrf} />
              <button class="quiet" type="submit">
                Cancel unused links
              </button>
            </form>
          </div>
        )}
      </section>

      <section class="section" id="devices">
        <div class="section-head">
          <div>
            <h2>Devices</h2>
            <p>
              Computers whose agents can publish. Add one with <code>artifact login</code>. A device can also create a view-only browser
              session with <code>artifact open</code>, so revoke any you no longer use.
            </p>
          </div>
        </div>
        <ul class="rows">
          {devices.results.length === 0 && <li class="empty">No devices yet.</li>}
          {devices.results.map((d) => (
            <li>
              <div class="main">
                <div class="title">{d.name}</div>
                <div class="desc">
                  Added <Time iso={d.created_at} />
                  {d.last_used_at && (
                    <>
                      {" · last used "}
                      <Time iso={d.last_used_at} />
                    </>
                  )}
                </div>
              </div>
              <div class="side">
                <form class="inline" method="post" action={`/settings/devices/${d.id}/revoke`}>
                  <CsrfField token={viewer.csrf} />
                  <button class="danger" type="submit">
                    Revoke
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="section" id="secrets">
        <div class="section-head">
          <div>
            <h2>Secrets</h2>
            <p>
              Links made with <code>artifact secret request</code> or <code>artifact secret share</code>. Only the recipient's browser can
              decrypt; this list shows who opened each link. Ended ones are kept here for 30 days without their contents.
            </p>
          </div>
        </div>
        <ul class="rows">
          {secrets.length === 0 && <li class="empty">No secret requests yet.</li>}
          {secrets.map((r) => {
            const status = secretStatus(r);
            return (
              <li>
                <div class="main">
                  <div class="title">
                    {r.label} <span class={`badge ${status === "sealed" || status === "claimed" ? "accent" : ""}`}>{r.mode === "share" && status === "sealed" ? "Opened" : SECRET_STATUS_LABEL[status]}</span>
                    {r.mode === "share" && <span class="badge">Share link</span>}
                  </div>
                  <div class="desc">
                    Created <Time iso={r.created_at} />
                    {r.claimed_at && (
                      <>
                        {" · opened "}
                        <Time iso={r.claimed_at} />
                        {r.claim_ip ? ` from ${r.claim_ip}` : ""}
                      </>
                    )}
                    {secretOpen(r) ? ` · expires ${formatTime(r.expires_at)}` : ""}
                  </div>
                </div>
                <div class="side">
                  {secretOpen(r) && (
                    <form class="inline" method="post" action={`/settings/secrets/${r.id}/delete`}>
                      <CsrfField token={viewer.csrf} />
                      <button class="danger" type="submit">
                        Delete
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section class="section" id="external">
        <div class="section-head">
          <div>
            <h2>External access</h2>
            <p>Artifacts that may send requests to other hosts. Removing access lasts until the artifact is published again with it.</p>
          </div>
        </div>
        <ul class="rows">
          {connecting.length === 0 && <li class="empty">No artifact talks to other hosts.</li>}
          {connecting.map((a) => (
            <li>
              <div class="main">
                <a class="title" href={`/a/${a.id}`}>
                  {a.title}
                </a>
                <div class="desc">{a.allow_connect.join(", ")}</div>
              </div>
              <div class="side">
                <form class="inline" method="post" action={`/settings/connect/${a.id}/revoke`}>
                  <CsrfField token={viewer.csrf} />
                  <button class="danger" type="submit">
                    Remove access
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="section" id="trash">
        <div class="section-head">
          <div>
            <h2>Trash</h2>
            <p>Deleted artifacts are removed for good {trashDays} days after deletion.</p>
          </div>
        </div>
        <ul class="rows">
          {trash.length === 0 && <li class="empty">The trash is empty.</li>}
          {trash.map((a) => (
            <li>
              <div class="main">
                <div class="title">{a.title}</div>
                <div class="desc">
                  Deleted <Time iso={a.deleted_at!} />
                </div>
              </div>
              <div class="side">
                <form class="inline" method="post" action={`/settings/trash/${a.id}/restore`}>
                  <CsrfField token={viewer.csrf} />
                  <button class="quiet" type="submit">
                    Restore
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="section" id="audit">
        <div class="section-head">
          <div>
            <h2>Recent security activity</h2>
            <p>Sign-ins, account and device changes, and publishing actions. The newest 50 events are shown.</p>
          </div>
        </div>
        <ul class="rows">
          {auditEvents.length === 0 && <li class="empty">No security activity has been recorded yet.</li>}
          {auditEvents.map((event) => (
            <li>
              <div class="main">
                <div class="title"><code>{event.action}</code></div>
                <div class="desc">
                  {event.actor_label ?? event.actor_id ?? event.actor_type}
                  {event.target_id ? ` · ${event.target_type} ${event.target_id}` : ` · ${event.target_type}`}
                  {event.ip_address ? ` · ${event.ip_address}` : ""}
                </div>
              </div>
              <div class="side">
                {event.result !== "success" && <span class="badge warn">{event.result}</span>}
                <Time iso={event.event_at} />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </Page>,
  );
});

root.post("/settings/invites", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const token = await createInvite(c.env.DB, "viewer", viewer.userId);
  await recordViewerAction(c, "invite.create", "invite", null, { role: "viewer" });
  const url = `${c.get("config").origin}/invite/${token}`;
  return c.html(
    <Page title="Invite link" viewer={viewer}>
      <div class="narrow">
        <h1>Invite link</h1>
        <p class="muted small">Send this to the person you want to add. It works once and expires in {INVITE_DAYS} days.</p>
        <p class="link-box">{url}</p>
        <p class="muted small">The link is shown only now. Whoever opens it first becomes a viewer.</p>
        <p style="margin-top:var(--space-5)">
          <a href="/settings#people">← Back to settings</a>
        </p>
      </div>
    </Page>,
  );
});

root.post("/settings/invites/revoke", requireSameOriginForm(), async (c) => {
  const revoked = await c.env.DB.prepare("delete from invites where used_at is null").run();
  await recordViewerAction(c, "invite.revoke_open", "invite", null, { count: revoked.meta.changes ?? 0 });
  return c.redirect("/settings#people", 303);
});

root.post("/settings/users/:id/remove", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  if (id === c.get("viewer").userId) return c.text("You cannot remove yourself.", 400);
  const target = await getUser(c.env.DB, id);
  await deleteUser(c.env.DB, id);
  await recordViewerAction(c, "user.remove", "user", id, { name: target?.name ?? "unknown", role: target?.role ?? "unknown" });
  return c.redirect("/settings#people", 303);
});

root.post("/settings/devices/:id/revoke", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  const device = await c.env.DB.prepare("select name from devices where id = ?").bind(id).first<{ name: string }>();
  await c.env.DB.prepare("update devices set revoked_at = ? where id = ?").bind(new Date().toISOString(), id).run();
  await recordViewerAction(c, "device.revoke", "device", id, { name: device?.name ?? "unknown" });
  return c.redirect("/settings#devices", 303);
});

root.post("/settings/secrets/:id/delete", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  if (await finishSecret(c.env.DB, id, "owner")) await recordViewerAction(c, "secret.delete", "secret", id);
  return c.redirect("/settings#secrets", 303);
});

root.post("/settings/connect/:id/revoke", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  await revokeConnect(c.env.DB, id);
  await recordViewerAction(c, "artifact.external_access_revoke", "artifact", id);
  return c.redirect("/settings#external", 303);
});

root.post("/settings/trash/:id/restore", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  await restoreArtifact(c.env.DB, id);
  await recordViewerAction(c, "artifact.restore", "artifact", id);
  return c.redirect("/settings#trash", 303);
});

// --- Device pairing approval (root only) ---

interface PairingRow {
  code: string;
  name: string;
  requested_ip: string | null;
  status: string;
  public_key: string;
  expires_at: string;
}

function findPairing(c: Context<AppEnv>, code: string): Promise<PairingRow | null> {
  return c.env.DB.prepare("select * from pairings where code = ?").bind(code.toUpperCase()).first<PairingRow>();
}

function isPending(row: PairingRow | null): row is PairingRow {
  return row?.status === "pending" && Date.parse(row.expires_at) > Date.now();
}

async function pendingPairing(c: Context<AppEnv>, code: string): Promise<PairingRow | undefined> {
  const row = await findPairing(c, code);
  return isPending(row) ? row : undefined;
}

/** What the approval page says once a request can no longer be approved (e.g. on reload). */
function closedPairing(row: PairingRow | null): { title: string; body: Child } {
  if (row?.status === "approved") {
    return { title: `${row.name} can publish`, body: <>This request was approved. You can close this tab.</> };
  }
  if (row?.status === "denied") {
    return { title: "This request was denied", body: <>{row.name} cannot publish. Run <code>artifact login</code> again if that was a mistake.</> };
  }
  return { title: "This login request has expired", body: <>Requests last 10 minutes. Run <code>artifact login</code> again.</> };
}

root.get("/pair/:code", async (c) => {
  const viewer = c.get("viewer");
  const row = await findPairing(c, c.req.param("code"));
  if (!isPending(row)) {
    const closed = closedPairing(row);
    return c.html(
      <Page title="Login request" viewer={viewer} narrow>
        <h1>{closed.title}</h1>
        <p class="muted">{closed.body}</p>
      </Page>,
      row ? 200 : 404,
    );
  }
  const pairing = row;
  return c.html(
    <Page title="Approve device" viewer={viewer} narrow>
      <h1>Let this device publish?</h1>
      <div class="card">
        <p>Check that the terminal shows the same code:</p>
        <p class="code">{pairing.code}</p>
        <p>
          Device name: <strong>{pairing.name}</strong>
          <br />
          <span class="muted">
            Requested from {pairing.requested_ip ?? "an unknown address"} · expires {formatTime(pairing.expires_at)}
          </span>
        </p>
        <div class="row">
          <form class="inline" method="post" action={`/pair/${pairing.code}`}>
            <CsrfField token={viewer.csrf} />
            <input type="hidden" name="decision" value="approve" />
            <button class="primary" type="submit">
              Approve
            </button>
          </form>
          <form class="inline" method="post" action={`/pair/${pairing.code}`}>
            <CsrfField token={viewer.csrf} />
            <input type="hidden" name="decision" value="deny" />
            <button class="danger" type="submit">
              Deny
            </button>
          </form>
        </div>
      </div>
      <p class="muted">If you did not run <code>artifact login</code> just now, deny it.</p>
    </Page>,
  );
});

root.post("/pair/:code", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const pairing = await pendingPairing(c, c.req.param("code"));
  if (!pairing) return c.redirect(`/pair/${c.req.param("code")}`, 303);
  const decision = (await c.req.parseBody())["decision"];
  if (decision === "approve") {
    const deviceId = randomId();
    const now = new Date().toISOString();
    const [inserted, claimed] = await c.env.DB.batch([
      // The INSERT itself checks that the pairing is still claimable. D1 executes a batch as one
      // transaction, so two approval requests cannot both create a device.
      c.env.DB.prepare(
        `insert into devices (id, name, public_key, created_at, user_id)
         select ?, name, public_key, ?, ? from pairings
         where code = ? and status = 'pending' and expires_at > ?`,
      ).bind(deviceId, now, viewer.userId, pairing.code, now),
      c.env.DB.prepare(
        `update pairings set status = 'approved', device_id = ?
         where code = ? and status = 'pending' and expires_at > ?
           and exists (select 1 from devices where id = ?)`,
      ).bind(deviceId, pairing.code, now, deviceId),
    ]);
    if (inserted?.meta.changes !== 1 || claimed?.meta.changes !== 1) {
      return c.redirect(`/pair/${c.req.param("code")}`, 303);
    }
    await recordViewerAction(c, "device.approve", "device", deviceId, { name: pairing.name });
  } else {
    await c.env.DB.prepare("update pairings set status = 'denied' where code = ? and status = 'pending' and expires_at > ?")
      .bind(pairing.code, new Date().toISOString())
      .run();
    await recordViewerAction(c, "device.deny", "pairing", null, { name: pairing.name });
  }
  return c.html(
    <Page title="Device" viewer={viewer} narrow>
      <h1>{decision === "approve" ? `${pairing.name} can now publish` : "Denied"}</h1>
      <p class="muted">You can close this tab and go back to the terminal.</p>
    </Page>,
  );
});

pages.route("/", root);
