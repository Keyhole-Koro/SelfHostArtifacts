import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../app-env.ts";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { passkeyLabel, registrationOptions, takeCeremony, verifyRegistration } from "../auth/passkeys.ts";
import { requireSameOriginForm, requireSameOriginJson, requireViewer } from "../auth/session.ts";
import { SANDBOX_FLAGS, mintContentToken } from "../content.ts";
import { EDITOR_PATH, frameSrc, markdownLinks } from "../doc.ts";
import { MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, addComment, deleteComment, getComment, listComments, openThreadCounts, setResolved, threadPeople, threadsOf, type CommentRow, type Thread } from "../db/comments.ts";
import { changeLabels, labelCounts, labeledSearch, labelsOf } from "../db/labels.ts";
import { BEAT_SECONDS, beat, editing, leave } from "../db/presence.ts";
import { hasConflictMarks, merge3 } from "../merge.ts";
import { BUILT_IN_TEMPLATES, TEMPLATE_LABEL, fromTemplatePage, markdownPages, type MarkdownPage } from "../templates.ts";
import { activityHref, listActivity, listNotifications, markRead, pageTarget, projectTarget, record, setWatch, watching, type ActivityRow } from "../db/activity.ts";
import { MAX_TEXT_CHARS, type VersionFile, labelSchema, labelsSchema, MAX_LABELS } from "@artifact/shared";
import { z } from "zod";
import { blobKey } from "./api.ts";
import { randomId, sha256Hex, utf8 } from "../lib/encoding.ts";
import { listRecentAuditEvents, recordAuditEvent } from "../db/audit.ts";
import {
  ancestorsOf,
  addVersion,
  createArtifact,
  getArtifact,
  getVersion,
  versionText,
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
  type VersionRow,
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
import { finishSecret, listSecrets, secretOpen, secretStatus } from "../db/secrets.ts";
import { renderSVG } from "uqr";
import { pageSecurity } from "../ui/security.ts";
import { Bell, CsrfField, Page, TOKENS, Time, formatTime } from "../ui/layout.tsx";
import { LabelChips, PageTree, TREE_STYLES } from "../ui/tree.tsx";
import { canEditProject, canSeeProject, getSpace, hiddenProjects, peopleWhoCanSee } from "../db/spaces.ts";
import { accessFor, canEditPage, canSeePage, listAccess, pageAudience, restrictionsOn, setAccess, setRestriction, type Access, type PathRestriction } from "../db/access.ts";
import { MARK_END, MARK_START, linkedFrom, linksTo, type LinkedPage } from "../db/search.ts";
import { INDEX_BATCH, hybridSearch, indexLater, indexPending, pendingPages, semanticOn } from "../db/semantic.ts";
import { semanticEnv } from "../env.ts";

export const pages = new Hono<AppEnv>();

/** A value written into an inline script: as JSON that cannot end the script element early (</script>) or a line (U+2028). */
function jsonInScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

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
.label-strip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); margin: calc(-1 * var(--space-2)) 0 var(--space-4); }
.label-strip .muted { margin-right: var(--space-1); }
.rows .chip { vertical-align: 1px; }
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
  const wanted = labelSchema.safeParse(c.req.query("label") ?? "");
  const label = wanted.success ? wanted.data : undefined;
  const access = await accessFor(c.env.DB, viewer);
  const hidden = access.hiddenProjects;
  const blocked = typeof selected === "string" && hidden.has(selected);
  const [all, allProjects, open, inUse] = await Promise.all([
    blocked ? [] : listArtifacts(c.env.DB, 200, selected, label),
    listProjects(c.env.DB),
    openThreadCounts(c.env.DB),
    labelCounts(c.env.DB, access, selected),
  ]);
  const artifacts = all.filter((a) => access.sees(a));
  // Pages hidden by a restriction are not counted either.
  const projects = allProjects
    .filter((p) => !p.project || !hidden.has(p.project))
    .map((p) => ({ ...p, count: p.count - (access.hiddenPerProject.get(p.project) ?? 0) }))
    .filter((p) => p.count > 0);
  // One project is shown as the tree of its pages, with what the space says about itself.
  const [allTree, space] =
    typeof selected === "string" && !blocked && !label ? await Promise.all([listProjectPages(c.env.DB, selected), getSpace(c.env.DB, selected)]) : [undefined, null];
  const tree = allTree?.filter((r) => !access.hiddenPages.has(r.id));
  const labels = await labelsOf(c.env.DB, tree ? tree.map((r) => r.id) : artifacts.map((a) => a.id));
  const canWrite = tree !== undefined && viewer.sessionKind === "full" && (await canEditProject(c.env.DB, viewer, selected as string));
  const templates = canWrite ? (await markdownPages(c.env.DB, selected as string, TEMPLATE_LABEL)).filter((r) => !access.hiddenPages.has(r.id)) : [];
  const [projectWatched, recentAll] = tree
    ? await Promise.all([watching(c.env.DB, viewer.userId, [projectTarget(selected as string)]), listActivity(c.env.DB, { project: selected as string, limit: 30 })])
    : [new Set<string>(), []];
  const recent = recentAll.filter((a) => access.sees({ id: a.artifact_id, project: a.page_project })).slice(0, 10);
  const total = projects.reduce((n, p) => n + p.count, 0);
  const showProjects = projects.some((p) => p.project !== null);
  const scope = selected === undefined ? "" : selected === null ? " without a project" : ` in ${selected}`;
  return c.html(
    <Page title={typeof selected === "string" ? `${selected} · Artifacts` : "Artifacts"} viewer={viewer}>
      <style>{raw(PROJECT_STYLES + TREE_STYLES + ACTIVITY_STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>{typeof selected === "string" ? selected : "Artifacts"}</h1>
          <p class="lead">
            {tree ? (space?.description ?? `${tree.length} ${tree.length === 1 ? "page" : "pages"}`) : (
              <>
                {artifacts.length} {artifacts.length === 1 ? "page" : "pages"}
                {label && ` labeled ${label}`}
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
        {artifacts.length > 0 && <input id="filter" class="search" type="search" placeholder="Filter this list" aria-label="Filter this list by title and description" />}
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
      {inUse.length > 0 && (
        <nav class="label-strip" aria-label="Labels">
          <span class="muted small">Labels</span>
          {inUse.slice(0, 30).map((l) => (
            <a
              class={`chip${l.label === label ? " current" : ""}`}
              href={l.label === label ? (selected === undefined ? "/" : projectHref(selected)) : `/?label=${encodeURIComponent(l.label)}${typeof selected === "string" ? `&project=${encodeURIComponent(selected)}` : ""}`}
              title={l.label === label ? "Show every page again" : `Pages labeled ${l.label}`}
            >
              {l.label} {l.count}
              {l.label === label && " ×"}
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
          {viewer.sessionKind === "full" && (
            <form method="post" action="/watch" style="margin:0 0 var(--space-3)">
              <CsrfField token={viewer.csrf} />
              <input type="hidden" name="project" value={selected as string} />
              <input type="hidden" name="on" value={projectWatched.size ? "0" : "1"} />
              <button type="submit" title="Hear about every new page, change and comment in this project">
                {projectWatched.size ? "★ Watching this project" : "☆ Watch this project"}
              </button>
            </form>
          )}
          {canWrite && (
            <form method="post" action="/new" class="field-row" style="margin-bottom:var(--space-4)">
              <CsrfField token={viewer.csrf} />
              <input type="hidden" name="project" value={selected as string} />
              <input name="title" type="text" required maxlength={200} placeholder="Title of a new page" aria-label="Title of a new page" />
              <TemplateChoice pages={templates} />
              <button type="submit" class="primary">
                Write a page
              </button>
            </form>
          )}
          <div class="card">
            <PageTree rows={tree} meta id="artifacts" labels={labels} />
            <p class="empty muted small" id="no-match" hidden>
              No page matches your search.
            </p>
          </div>
          {recent.length > 0 && (
            <section class="section">
              <div class="section-head">
                <h2>Recent activity</h2>
                <a href="/activity" class="small">
                  All activity
                </a>
              </div>
              <ul class="feed">
                {recent.map((a) => (
                  <li>
                    <ActivityLine a={a} />
                    <span class="when">
                      <Time iso={a.at} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
                  )}{" "}
                  {(open.get(a.id) ?? 0) > 0 && (
                    <span class="badge" title="Open comment threads">
                      {open.get(a.id)} {open.get(a.id) === 1 ? "comment" : "comments"}
                    </span>
                  )}{" "}
                  <LabelChips labels={labels.get(a.id)} />
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
.links { width: min(340px, calc(100vw - 24px)); }
.chips { display: flex; gap: var(--space-1); min-width: 0; overflow: hidden; }
.label-panel { width: min(300px, calc(100vw - 24px)); }
.label-panel ul { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1); }
.label-panel li { display: flex; align-items: center; gap: 2px; }
.label-panel a.chip { display: inline-block; padding: 0 var(--space-2); line-height: 1.6; margin: 0; }
.label-panel h3 { margin-top: 0; }
.access-panel { width: min(340px, calc(100vw - 24px)); }
.access-panel h3 { margin: 0; font-size: var(--text-xs); color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
.access-panel .modes { display: grid; gap: var(--space-2); }
.access-panel .mode { display: flex; gap: var(--space-2); align-items: flex-start; cursor: pointer; }
.access-panel .mode input[type=radio] { flex: none; width: 16px; height: 16px; margin: 3px 0 0; padding: 0; border: 0; accent-color: var(--accent); }
.access-panel .modes button { justify-self: start; }
.access-panel .people { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.access-panel .people li { display: flex; align-items: center; gap: var(--space-2); }
.access-panel .people li > span:first-child { flex: 1; color: var(--text); }
.access-panel .people button { border: 0; background: none; padding: 0 4px; color: var(--text-2); }
.access-panel select { font: inherit; font-size: var(--text-xs); padding: 4px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); min-width: 0; }
.access-panel .link select[name=user] { flex: 1; }
.label-panel li form { margin: 0; }
.label-panel li button { border: 0; background: none; color: var(--text-2); cursor: pointer; padding: 0 2px; font: inherit; }
.label-panel li button:hover { color: var(--danger, var(--warning)); }
@media (max-width: 900px) { .chips { display: none; } }
.bell { position: relative; } .bell-count { position: absolute; top: 0; right: 0; min-width: 15px; padding: 0 3px; border-radius: 999px; background: var(--accent); color: var(--accent-text, #fff); font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; }
.mention-list { list-style: none; margin: 0; padding: var(--space-1); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: 0 4px 12px rgb(0 0 0 / 0.15); min-width: 180px; }
.mention-list li { padding: 4px var(--space-2); border-radius: var(--radius-sm); cursor: pointer; }
.mention-list li.on, .mention-list li:hover { background: var(--accent-soft); color: var(--accent); }
.c-body .mention { color: var(--accent); font-weight: 600; }
.main { position: relative; }
.count { font-size: var(--text-xs); font-weight: 600; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--accent); color: var(--accent-text, #fff); text-align: center; }
.comments { display: none; width: 340px; flex-shrink: 0; overflow: auto; border-left: 1px solid var(--border); background: var(--surface); padding: var(--space-3); }
body.with-comments .comments { display: block; }
.comments h2 { font-size: var(--text-sm); margin: 0 0 var(--space-3); }
.comments textarea { width: 100%; box-sizing: border-box; min-height: 64px; font: inherit; padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); resize: vertical; }
.comments button { font: inherit; padding: 3px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; }
.comments button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text, #fff); }
.comments blockquote { margin: 0 0 var(--space-2); padding: 2px var(--space-2); border-left: 3px solid #e0b000; color: var(--text-2); cursor: pointer; white-space: pre-wrap; }
.c-new { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.c-new button { justify-self: end; }
.thread { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); margin: 0 0 var(--space-3); background: var(--bg); }
.thread.flash { outline: 2px solid var(--accent); }
.thread.settled { opacity: 0.75; }
.c-head { color: var(--text-2); font-size: var(--text-xs); display: flex; gap: var(--space-1); align-items: baseline; flex-wrap: wrap; }
.c-head strong { color: var(--text); }
.c-del { margin-left: auto; } .c-del button { border: 0; background: none; color: var(--text-2); padding: 0; font-size: var(--text-xs); }
.c-body { white-space: pre-wrap; word-break: break-word; margin: 2px 0 var(--space-2); }
.reply { border-top: 1px solid var(--border); padding-top: var(--space-2); }
.c-actions { display: flex; gap: var(--space-2); align-items: flex-start; flex-wrap: wrap; }
.c-actions details { flex: 1; } .c-actions summary { cursor: pointer; color: var(--accent); }
.c-actions details form { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
.settled-list summary { cursor: pointer; color: var(--text-2); margin-bottom: var(--space-2); }
.sel-btn { position: absolute; right: 16px; top: 12px; z-index: 2; font: inherit; font-weight: 600; padding: 6px var(--space-3); border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: var(--accent-text, #fff); box-shadow: 0 2px 10px rgb(0 0 0 / 0.2); cursor: pointer; }
body.with-comments .sel-btn { right: 356px; }
.links h3 { margin: var(--space-2) var(--space-3) var(--space-1); font-size: var(--text-xs); color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
.panel a.compare { border-top: 1px solid var(--border); border-radius: 0; margin-top: var(--space-1); color: var(--accent); }
.move h3 { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em; }
.short { display: none; }
.share { width: min(360px, calc(100vw - 24px)); padding: var(--space-3); display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
.share .new-page { flex-wrap: wrap; }
.share .new-page input[name=title] { flex: 1 1 100%; }
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
  body.with-comments .comments { position: fixed; top: 44px; bottom: 0; right: 0; z-index: 3; width: min(340px, 90vw); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
  body.with-comments .sel-btn { right: 16px; }
  .panel.share { position: fixed; top: 50px; left: 12px; right: 12px; width: auto; }
  .short { display: inline; }
}
`;

async function viewerPage(c: Context<AppEnv>, id: string, requested: number | undefined) {
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  // A page in a space the viewer is not let into is answered like a page that does not exist.
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
  const versionNumber = requested ?? artifact.current_version;
  const version = await getVersion(c.env.DB, id, versionNumber);
  if (!version) return c.notFound();
  const versions = await listVersions(c.env.DB, id);
  const access = await accessFor(c.env.DB, viewer);
  const tree = artifact.project ? (await listProjectPages(c.env.DB, artifact.project)).filter((r) => !access.hiddenPages.has(r.id)) : undefined;
  const trail = tree ? ancestorsOf(tree, id) : [];
  const editor = viewer.role !== "root" && viewer.sessionKind === "full" && (await canEditPage(c.env.DB, viewer, artifact));
  const visible = (rows: LinkedPage[]) => rows.filter((r) => access.sees(r));
  const [from, to, comments] = await Promise.all([linkedFrom(c.env.DB, id).then(visible), linksTo(c.env.DB, id).then(visible), listComments(c.env.DB, id)]);
  const threads = threadsOf(comments);
  const [watched, projectPeople, labelMap, restrictions, audience] = await Promise.all([
    watching(c.env.DB, viewer.userId, [pageTarget(id)]),
    peopleWhoCanSee(c.env.DB, artifact.project),
    labelsOf(c.env.DB, [id]),
    restrictionsOn(c.env.DB, id),
    pageAudience(c.env.DB, id),
  ]);
  const labels = labelMap.get(id) ?? [];
  // Only the people who may see this page can be named in its comments.
  const people = projectPeople.filter(audience).map((p) => ({ id: p.id, name: p.name }));
  const mayRestrict = (viewer.role === "root" || editor) && viewer.sessionKind === "full";
  const accessRows = mayRestrict ? await listAccess(c.env.DB, id) : [];
  const openThreads = threads.filter((t) => !t.first.resolved_at);
  const full = viewer.sessionKind === "full";
  const settles = (t: Thread) => full && (viewer.role === "root" || editor || t.first.author_user === viewer.userId);
  const deletes = (x: CommentRow) => full && (viewer.role === "root" || x.author_user === viewer.userId);
  const projects = viewer.role === "root" ? await listProjects(c.env.DB) : [];
  const templates = tree && (viewer.role === "root" || editor) ? (await markdownPages(c.env.DB, artifact.project, TEMPLATE_LABEL)).filter((r) => !access.hiddenPages.has(r.id)) : [];
  const shareUrl = shareActive(artifact)
    ? `${c.get("config").origin}${sharePath(id, await shareKey(c.env.CONTENT_TOKEN_SECRET, id, artifact.share_nonce))}`
    : undefined;
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, versionNumber, undefined, viewer.userId);
  const src = frameSrc(token, version.entry);
  const nonce = c.get("nonce");
  const isLatest = versionNumber === artifact.current_version;
  const markdown = version.entry.endsWith(".md");
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
          <a id="newer" class="badge public" href={`/a/${id}`} hidden title="A newer version was saved after you opened this page" />
          <span id="editing" class="badge public" hidden />
          {version.allow_connect.length > 0 && (
            <span class="badge" title={`May connect to ${version.allow_connect.join(", ")}`}>
              external
            </span>
          )}
          {shareUrl && <span class="badge public">public</span>}
          {restrictions.length > 0 && !mayRestrict && (
            <span class="badge public" title={restrictions.some((r) => r.restriction === "view") ? "Only some people can view this page" : "Only some people can edit this page"}>
              restricted
            </span>
          )}
          {labels.length > 0 && (
            <span class="chips">
              <LabelChips labels={labels} />
            </span>
          )}
          <span class="spacer" />
          {(viewer.role === "root" || editor) && viewer.sessionKind === "full" && (
            <LabelPanel id={id} labels={labels} csrf={viewer.csrf} open={c.req.query("labels") === "1"} />
          )}
          {mayRestrict && (
            <AccessPanel
              id={id}
              csrf={viewer.csrf}
              restrictions={restrictions}
              rows={accessRows}
              people={projectPeople.filter((p) => p.role !== "root")}
              me={viewer.userId}
              open={c.req.query("access") === "1"}
            />
          )}
          {(viewer.role === "root" || editor) && (
            <MovePanel
              id={id}
              project={artifact.project}
              projects={viewer.role === "root" ? projects.flatMap((p) => (p.project ? [p.project] : [])) : undefined}
              csrf={viewer.csrf}
              tree={tree}
              parent={artifact.parent}
              templates={templates}
            />
          )}
          {viewer.role === "root" && (
            <SharePanel id={id} artifact={artifact} shareUrl={shareUrl} csrf={viewer.csrf} open={c.req.query("share") === "1"} />
          )}
          {markdown && isLatest && (viewer.role === "root" || editor) && viewer.sessionKind === "full" && (
            <a href={`/a/${id}/edit`} class="tool" title="Edit this page">
              ✎ <span class="label">Edit</span>
            </a>
          )}
          {viewer.sessionKind === "full" && (
            <form method="post" action="/watch" style="margin:0">
              <CsrfField token={viewer.csrf} />
              <input type="hidden" name="page" value={id} />
              <input type="hidden" name="on" value={watched.size ? "0" : "1"} />
              <button type="submit" class="tool" title={watched.size ? "Stop hearing about this page" : "Hear about changes and comments on this page"} style="border:0;background:none;font:inherit">
                <span class="label">{watched.size ? "Watching" : "Watch"}</span>
                <span class="short">{watched.size ? "★" : "☆"}</span>
              </button>
            </form>
          )}
          <Bell unread={viewer.unread} class="tool bell" />
          <button type="button" id="comments-toggle" class="tool" aria-controls="comments" title="Comments" style="border:0;background:none;font:inherit">
            <span class="label">Comments</span>
            <span class="short">✉</span>
            {openThreads.length > 0 && <span class="count">{openThreads.length}</span>}
          </button>
          {(from.length > 0 || to.length > 0) && <LinksPanel from={from} to={to} />}
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
              {versions.length > 1 && (
                <a href={`/a/${id}/diff?from=${versions[1]!.version}&to=${versions[0]!.version}`} class="compare">
                  Compare versions…
                </a>
              )}
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
          <button type="button" id="sel-btn" class="sel-btn" hidden>
            Comment on the selection
          </button>
          <CommentsPanel id={id} threads={threads} csrf={viewer.csrf} canWrite={full} canSettle={settles} canDelete={deletes} />
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
// Someone saving or editing this page meanwhile: say so, and offer the newer version.
{
  const shown = ${versionNumber}, latest = ${JSON.stringify(isLatest)};
  const newer = document.getElementById("newer"), editors = document.getElementById("editing");
  const poll = async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(${JSON.stringify(`/a/${id}/state`)}, { credentials: "same-origin" });
      if (!res.ok) return;
      const s = await res.json();
      if (latest && s.version > shown) { newer.textContent = "v" + s.version + " by " + s.by + " · show it"; newer.hidden = false; }
      editors.textContent = s.editing.length ? s.editing.join(", ") + " editing" : "";
      editors.hidden = !s.editing.length;
    } catch {}
  };
  setInterval(poll, 30000);
  document.addEventListener("visibilitychange", poll);
  poll();
}
// Comments beside the page; a passage selected in the page can be commented on, and commented ones are marked.
const frame = document.getElementById("frame");
const commentsOn = (on) => { document.body.classList.toggle("with-comments", on); document.getElementById("comments-toggle").setAttribute("aria-expanded", String(on)); };
document.getElementById("comments-toggle").addEventListener("click", () => commentsOn(!document.body.classList.contains("with-comments")));
if (new URLSearchParams(location.search).get("comments") === "1") commentsOn(true);
const quotes = ${jsonInScript(openThreads.filter((t) => t.first.quote).map((t) => ({ id: t.first.id, text: t.first.quote })))};
const selBtn = document.getElementById("sel-btn");
let selected = "";
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === "artifact:ready") frame.contentWindow.postMessage({ type: "artifact:highlight", quotes }, "*");
  if (d.type === "artifact:selection" && typeof d.text === "string") { selected = d.text.slice(0, 500); selBtn.hidden = !selected || !document.getElementById("c-body"); }
  if (d.type === "artifact:comment" && typeof d.id === "string") {
    commentsOn(true);
    const t = document.getElementById("c-" + d.id.replace(/[^0-9a-z]/g, ""));
    if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1500); }
  }
});
selBtn.addEventListener("click", () => {
  commentsOn(true);
  document.getElementById("c-quote").value = selected;
  const show = document.getElementById("c-quote-show");
  show.textContent = selected; show.hidden = false;
  document.getElementById("c-body").focus();
  selBtn.hidden = true;
});
for (const q of document.querySelectorAll("[data-focus]")) q.addEventListener("click", () => frame.contentWindow.postMessage({ type: "artifact:focus", id: q.dataset.focus }, "*"));
// @ in a comment suggests the people who can see this page; choosing one records who was named.
const people = ${jsonInScript(people)};
for (const area of document.querySelectorAll(".comments textarea")) {
  const ids = area.form.querySelector('input[name="mentions"]');
  const list = document.createElement("ul"); list.className = "mention-list"; list.hidden = true;
  area.after(list);
  let at = -1, picks = [], on = 0;
  const close = () => { list.hidden = true; at = -1; };
  const choose = (p) => {
    area.setRangeText("@" + p.name + " ", at, area.selectionStart, "end");
    ids.value = [...new Set([...ids.value.split(",").filter(Boolean), p.id])].join(",");
    close(); area.focus();
  };
  const show = () => {
    list.replaceChildren(...picks.map((p, k) => { const li = document.createElement("li"); li.textContent = p.name; if (k === on) li.className = "on"; li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p); }); return li; }));
    list.hidden = picks.length === 0;
  };
  area.addEventListener("input", () => {
    const before = area.value.slice(0, area.selectionStart), m = /(^|\\s)@([^@\\n]{0,30})$/.exec(before);
    if (!m) return close();
    at = before.length - m[2].length - 1;
    const q = m[2].toLowerCase();
    picks = people.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6); on = 0; show();
  });
  area.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); on = (on + (e.key === "ArrowDown" ? 1 : picks.length - 1)) % picks.length; show(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(picks[on]); }
    else if (e.key === "Escape") close();
  });
  area.addEventListener("blur", () => setTimeout(close, 150));
}
// Names in comments stand out: each text node is split at "@Name", nothing is parsed as HTML.
for (const b of document.querySelectorAll(".c-body")) {
  const text = b.textContent, names = people.map((p) => "@" + p.name).filter((n) => text.includes(n));
  if (!names.length) continue;
  const parts = [];
  let rest = text;
  while (rest) {
    let best = -1, name = "";
    for (const n of names) { const k = rest.indexOf(n); if (k >= 0 && (best < 0 || k < best)) { best = k; name = n; } }
    if (best < 0) { parts.push(rest); break; }
    if (best > 0) parts.push(rest.slice(0, best));
    const span = document.createElement("span"); span.className = "mention"; span.textContent = name; parts.push(span);
    rest = rest.slice(best + name.length);
  }
  b.replaceChildren(...parts);
}
// A link to another artifact, clicked inside the page (see NAV_JS in content.ts).
window.addEventListener("message", (e) => {
  if (e.source !== document.getElementById("frame").contentWindow) return;
  const d = e.data;
  if (d && d.type === "artifact:navigate" && typeof d.path === "string" && /^\\/a\\/[0-9a-z]{16}(\\/v\\/[0-9]+)?\\/?(#[^\\s<>"]*)?$/.test(d.path)) location.href = d.path;
});
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
/** The comments beside a page: open threads first, then the settled ones folded. */
function CommentsPanel(props: { id: string; threads: Thread[]; csrf: string; canWrite: boolean; canSettle: (t: Thread) => boolean; canDelete: (c: CommentRow) => boolean }) {
  const { id, threads, csrf } = props;
  const open = threads.filter((t) => !t.first.resolved_at), settled = threads.filter((t) => t.first.resolved_at);
  const one = (c: CommentRow, reply: boolean) => (
    <div class={reply ? "reply" : undefined}>
      <div class="c-head">
        <strong>{c.author_name}</strong>
        {c.author_device && " (agent)"} · <Time iso={c.created_at} /> · v{c.version}
        {props.canDelete(c) && (
          <form method="post" action={`/a/${id}/comments/${c.id}/delete`} class="inline c-del">
            <CsrfField token={csrf} />
            <button type="submit" title={reply ? "Delete this reply" : "Delete this thread"}>
              Delete
            </button>
          </form>
        )}
      </div>
      <div class="c-body">{c.body}</div>
    </div>
  );
  const thread = (t: Thread) => (
    <article class={`thread${t.first.resolved_at ? " settled" : ""}`} id={`c-${t.first.id}`}>
      {t.first.quote && (
        <blockquote data-focus={t.first.id} title="Show this passage in the page">
          {t.first.quote}
        </blockquote>
      )}
      {one(t.first, false)}
      {t.replies.map((r) => one(r, true))}
      <div class="c-actions">
        {props.canWrite && (
          <details>
            <summary>Reply</summary>
            <form method="post" action={`/a/${id}/comments`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="reply_to" value={t.first.id} />
              <input type="hidden" name="mentions" value="" />
              <textarea name="body" required maxlength={4000} aria-label="Reply" />
              <button type="submit">Reply</button>
            </form>
          </details>
        )}
        {props.canSettle(t) && (
          <form method="post" action={`/a/${id}/comments/${t.first.id}/resolve`} class="inline">
            <CsrfField token={csrf} />
            <input type="hidden" name="resolved" value={t.first.resolved_at ? "0" : "1"} />
            <button type="submit">{t.first.resolved_at ? "Reopen" : "Resolve"}</button>
          </form>
        )}
      </div>
    </article>
  );
  return (
    <aside id="comments" class="comments" aria-label="Comments">
      <h2>Comments</h2>
      {props.canWrite && (
        <form method="post" action={`/a/${id}/comments`} class="c-new">
          <CsrfField token={csrf} />
          <input type="hidden" name="quote" id="c-quote" value="" />
          <input type="hidden" name="mentions" value="" />
          <blockquote id="c-quote-show" hidden />
          <textarea name="body" id="c-body" required maxlength={4000} placeholder="Comment on this page, or select a passage in it first" aria-label="New comment" />
          <button type="submit" class="primary">
            Comment
          </button>
        </form>
      )}
      {open.length === 0 && settled.length === 0 && <p class="muted">No comments yet.</p>}
      {open.map(thread)}
      {settled.length > 0 && (
        <details class="settled-list">
          <summary>Resolved ({settled.length})</summary>
          {settled.map(thread)}
        </details>
      )}
    </aside>
  );
}

/** The pages that link to this one and the pages it links to (only those the viewer may see). */
function LinksPanel(props: { from: LinkedPage[]; to: LinkedPage[] }) {
  const list = (rows: LinkedPage[]) => rows.map((r) => <a href={`/a/${r.id}`}>{r.title}{r.project && <span>{r.project}</span>}</a>);
  return (
    <details>
      <summary class="tool" title="Pages linked from and to this one">
        <span class="label">Links</span>
        <span class="short">⇄</span> {props.from.length + props.to.length} ▾
      </summary>
      <div class="panel links">
        {props.from.length > 0 && (
          <>
            <h3>Linked from</h3>
            {list(props.from)}
          </>
        )}
        {props.to.length > 0 && (
          <>
            <h3>Links to</h3>
            {list(props.to)}
          </>
        )}
      </div>
    </details>
  );
}

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

/** Who may see and change a page, beyond what its project allows. */
function AccessPanel(props: {
  id: string;
  csrf: string;
  restrictions: PathRestriction[];
  rows: { user_id: string; name: string; can: string }[];
  people: { id: string; name: string }[];
  me: string;
  open: boolean;
}) {
  const { id, csrf, rows } = props;
  const own = props.restrictions.find((r) => r.own)?.restriction ?? null;
  const above = props.restrictions.filter((r) => !r.own);
  const modes = [
    { value: "", label: "Open", note: "Everyone who can see the project views it; its editors change it." },
    { value: "edit", label: "Only some can edit", note: "Everyone who can see the project views it; the people below change it." },
    { value: "view", label: "Only some can view", note: "Nobody else sees it, nor the pages under it." },
  ];
  const candidates = props.people.filter((p) => !rows.some((r) => r.user_id === p.id));
  return (
    <details open={props.open}>
      <summary class="tool" title="Who may see and change this page">
        <span class="label">{own || above.length ? "Restricted" : "Access"}</span>
        <span class="short">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        </span>{" "}
        ▾
      </summary>
      <div class="panel share access-panel">
        <h3>Who may see and change this page</h3>
        <form method="post" action={`/a/${id}/access`} class="modes">
          <CsrfField token={csrf} />
          {modes.map((m) => (
            <label class="mode">
              <input type="radio" name="restriction" value={m.value} checked={(own ?? "") === m.value} />
              <span>
                <strong>{m.label}</strong>
                <br />
                <span class="muted small">{m.note}</span>
              </span>
            </label>
          ))}
          <button type="submit" class="primary">
            Save
          </button>
        </form>
        {own && (
          <>
            <h3>People</h3>
            <ul class="people">
              {rows.map((r) => (
                <li>
                  <span>{r.name}</span>
                  <span class="muted small">{r.can === "edit" ? "can edit" : "can view"}</span>
                  {r.user_id !== props.me && (
                    <form method="post" action={`/a/${id}/access/remove`}>
                      <CsrfField token={csrf} />
                      <input type="hidden" name="user" value={r.user_id} />
                      <button type="submit" title={`Take ${r.name} off`} aria-label={`Take ${r.name} off`}>
                        ×
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {candidates.length > 0 && (
              <form method="post" action={`/a/${id}/access/people`} class="link">
                <CsrfField token={csrf} />
                <select name="user" aria-label="Person">
                  {candidates.map((p) => (
                    <option value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select name="can" aria-label="What they may do">
                  {own === "view" && <option value="view">can view</option>}
                  <option value="edit">can edit</option>
                </select>
                <button type="submit">Add</button>
              </form>
            )}
            <p class="muted small">The owner always sees and changes every page.</p>
          </>
        )}
        {above.length > 0 && (
          <p class="muted small">
            The pages above it restrict it too:{" "}
            {above.map((r, k) => (
              <>
                {k > 0 && ", "}
                <a href={`/a/${r.id}`} style="display:inline;padding:0">
                  {r.title}
                </a>{" "}
                ({r.restriction === "view" ? "only some can view" : "only some can edit"})
              </>
            ))}
            .
          </p>
        )}
      </div>
    </details>
  );
}

/** A page's labels, to add and remove. */
function LabelPanel(props: { id: string; labels: string[]; csrf: string; open: boolean }) {
  const { id, labels, csrf } = props;
  return (
    <details open={props.open}>
      <summary class="tool" title="Labels: words that group pages across projects">
        <span class="label">Labels</span>
        <span class="short">#</span> ▾
      </summary>
      <div class="panel share label-panel">
        <h3>Labels</h3>
        {labels.length > 0 ? (
          <ul>
            {labels.map((l) => (
              <li>
                <a class="chip" href={`/?label=${encodeURIComponent(l)}`}>
                  {l}
                </a>
                <form method="post" action={`/a/${id}/labels/remove`}>
                  <CsrfField token={csrf} />
                  <input type="hidden" name="label" value={l} />
                  <button type="submit" title={`Remove ${l}`} aria-label={`Remove the label ${l}`}>
                    ×
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted small">No labels yet. A label groups pages across projects, like “decision” or “draft”.</p>
        )}
        <form method="post" action={`/a/${id}/labels`} class="link">
          <CsrfField token={csrf} />
          <input name="add" type="text" required maxlength={200} placeholder="decision, draft" aria-label="Labels to add, separated by commas" />
          <button type="submit" class="primary">
            Add
          </button>
        </form>
      </div>
    </details>
  );
}

/** `projects`: the owner's choice of projects; an editor (without it) only moves pages within the project. */
/** Which template a new page starts from: the built-in ones, then the project's template pages. */
function TemplateChoice(props: { pages: MarkdownPage[] }) {
  return (
    <select name="template" aria-label="Start from a template">
      {BUILT_IN_TEMPLATES.map((t) => (
        <option value={t.id}>{t.name}</option>
      ))}
      {props.pages.length > 0 && (
        <optgroup label="This project's templates">
          {props.pages.map((p) => (
            <option value={`page:${p.id}`}>{p.title}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function MovePanel(props: { id: string; project: string | null; projects?: string[]; csrf: string; tree?: TreeRow[]; parent: string | null; templates?: MarkdownPage[] }) {
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
            <h3>New page under this one</h3>
            <form method="post" action="/new" class="link new-page">
              <CsrfField token={csrf} />
              <input type="hidden" name="parent" value={id} />
              <input name="title" type="text" required maxlength={200} placeholder="Title" aria-label="Title of the new page" />
              <TemplateChoice pages={props.templates ?? []} />
              <button type="submit">Write</button>
            </form>
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
  if (!artifact || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.json({ error: "not found" }, 404);
  const version = await getVersion(c.env.DB, id, Number(c.req.query("v") ?? artifact.current_version));
  if (!version) return c.json({ error: "not found" }, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version, undefined, c.get("viewer").userId);
  return c.json({ src: frameSrc(token, version.entry), exp });
});

/** A version's text as recorded when it was published, for comparing versions. */
pages.get("/a/:id/text", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.json({ error: "not found" }, 404);
  const version = Number(c.req.query("v") ?? artifact.current_version);
  const text = await versionText(c.env.DB, id, version);
  if (text === undefined) return c.json({ error: "not found" }, 404);
  return c.json({ version, text });
});

const DIFF_STYLES = `
.diff-pick { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-4); }
.diff-pick select { font: inherit; padding: 4px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.diff { font: var(--text-sm)/1.6 var(--font-sans); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.diff div { padding: 2px var(--space-3); white-space: pre-wrap; word-break: break-word; }
.diff .add { background: color-mix(in srgb, var(--positive, #1a7f37) 12%, var(--surface)); }
.diff .del { background: color-mix(in srgb, var(--negative, #c0362c) 12%, var(--surface)); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--negative, #c0362c) 60%, transparent); }
.diff .add::before { content: "+ "; color: var(--text-2); } .diff .del::before { content: "− "; color: var(--text-2); }
.diff .same { color: var(--text-2); }
.diff .gap { color: var(--text-2); text-align: center; font-size: var(--text-xs); background: var(--surface-2); }
`;

/**
 * Two versions' text as one list of lines: removed, added, and the unchanged ones around them.
 * The browser compares them; the Worker only hands out the texts.
 */
pages.get("/a/:id/diff", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
  const versions = await listVersions(c.env.DB, id);
  const pick = (q: string | undefined, fallback: number) => (versions.some((v) => v.version === Number(q)) ? Number(q) : fallback);
  const to = pick(c.req.query("to"), artifact.current_version);
  const from = pick(c.req.query("from"), versions.find((v) => v.version < to)?.version ?? to);
  return c.html(
    <Page title={`${artifact.title} · Compare`} viewer={viewer}>
      <style>{raw(DIFF_STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>{artifact.title}</h1>
          <p class="lead">
            What changed in the page's text. <a href={`/a/${id}`}>Back to the page</a>
          </p>
        </div>
      </div>
      <form class="diff-pick" method="get">
        <label>
          From{" "}
          <select name="from">
            {versions.map((v) => (
              <option value={String(v.version)} selected={v.version === from}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          to{" "}
          <select name="to">
            {versions.map((v) => (
              <option value={String(v.version)} selected={v.version === to}>
                v{v.version}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Compare</button>
      </form>
      <div class="diff" id="diff" aria-live="polite">
        <div class="gap">Comparing…</div>
      </div>
      <script nonce={c.get("nonce")}>
        {raw(`
const from = ${from}, to = ${to}, base = ${JSON.stringify(`/a/${id}/text?v=`)};
const box = document.getElementById("diff");
const row = (cls, text) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };
// Longest common subsequence of lines; a text is at most 100,000 characters.
function diff(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4e6) return [...a.map((t) => ["del", t]), ...b.map((t) => ["add", t])];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(["same", a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(["del", a[i++]]);
    else out.push(["add", b[j++]]);
  }
  while (i < n) out.push(["del", a[i++]]);
  while (j < m) out.push(["add", b[j++]]);
  return out;
}
(async () => {
  const [x, y] = await Promise.all([from, to].map(async (v) => { const r = await fetch(base + v, { credentials: "same-origin" }); return r.ok ? (await r.json()).text : null; }));
  box.replaceChildren();
  if (x === null || y === null) {
    box.append(row("gap", "No text was recorded for v" + (x === null ? from : to) + ": it was published before versions kept their text, or by an older artifact CLI."));
    return;
  }
  const lines = diff(x.split("\\n"), y.split("\\n"));
  if (!lines.some(([k]) => k !== "same")) { box.append(row("gap", "The text did not change.")); return; }
  // Unchanged lines more than 2 away from a change fold into one row.
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - 2), k + 3).some(([t]) => t !== "same"));
  let skipped = 0;
  const flush = () => { if (skipped) { box.append(row("gap", skipped + " unchanged line" + (skipped === 1 ? "" : "s"))); skipped = 0; } };
  lines.forEach(([kind, text], k) => {
    if (kind === "same" && !near[k]) { skipped++; return; }
    flush();
    box.append(row(kind, text));
  });
  flush();
})();`)}
      </script>
    </Page>,
  );
});

// --- Search ---

const SEARCH_STYLES = `
.hits { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-4); }
.hits a.title { font-weight: 600; font-size: var(--text-md); }
.hits .snip { margin: var(--space-1) 0 0; color: var(--text-2); font-size: var(--text-sm); }
.hits mark { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--text); border-radius: 2px; padding: 0 1px; }
.searchbar { display: flex; gap: var(--space-2); margin-bottom: var(--space-5); }
.searchbar input { flex: 1; }
`;

/** Escapes `text` for HTML and turns the search marks into <mark>. */
function marked(text: string): string {
  // The marks are \u0001 and \u0002; every other character that HTML could read as markup is escaped.
  const esc = text.replace(/[&<>"'\u0000\u0003-\u0008]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return esc.replaceAll(MARK_START, "<mark>").replaceAll(MARK_END, "</mark>");
}

pages.get("/search", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const access = await accessFor(c.env.DB, viewer);
  const hits = q ? (await labeledSearch(semanticEnv(c.env), q, 100)).filter((h) => access.sees(h)) : [];
  const labels = await labelsOf(c.env.DB, hits.map((h) => h.id));
  return c.html(
    <Page title={q ? `${q} · Search` : "Search"} viewer={viewer}>
      <style>{raw(SEARCH_STYLES + TREE_STYLES)}</style>
      <h1>Search</h1>
      <form class="searchbar" method="get" action="/search" role="search">
        <input class="search" type="search" name="q" value={q} placeholder="Words in a page's title or text; label:name for a label" aria-label="Search pages" autofocus />
        <button type="submit" class="primary">
          Search
        </button>
      </form>
      {q && <p class="muted small">{hits.length === 0 ? "No page has every one of these words." : `${hits.length} ${hits.length === 1 ? "page" : "pages"}`}</p>}
      <ul class="hits">
        {hits.map((h) => (
          <li>
            <a class="title" href={`/a/${h.id}`}>
              {h.title}
            </a>{" "}
            {h.project && <span class="badge">{h.project}</span>}{" "}
            {h.match === "meaning" && (
              <span class="badge" title="Found by meaning: the page does not have these words, but says something close">
                by meaning
              </span>
            )}{" "}
            <LabelChips labels={labels.get(h.id)} /> <span class="muted small">· <Time iso={h.updated_at} /></span>
            {h.snippet && <p class="snip">{raw(marked(h.snippet))}</p>}
          </li>
        ))}
      </ul>
    </Page>,
  );
});


// --- Pages written in the browser (Markdown) ---

const MAX_MARKDOWN_BYTES = 1_000_000;

/** The device that browser edits are recorded under: one per person, revoked, so it can never sign a request. */
async function browserDevice(c: Context<AppEnv>): Promise<string> {
  const viewer = c.get("viewer");
  const id = `web-${viewer.userId}`;
  const now = new Date().toISOString();
  await c.env.DB.prepare("insert or ignore into devices (id, name, public_key, created_at, revoked_at, user_id) values (?, ?, '', ?, ?, ?)")
    .bind(id, `${viewer.name} (browser)`, now, now, viewer.userId)
    .run();
  return id;
}

/** Stores a Markdown text as a blob, unless it is there already; returns its file entry. */
async function storeMarkdown(c: Context<AppEnv>, markdown: string): Promise<VersionFile> {
  const bytes = utf8(markdown);
  const sha256 = await sha256Hex(bytes);
  if (!(await c.env.BLOBS.head(blobKey(sha256)))) await c.env.BLOBS.put(blobKey(sha256), bytes, { sha256 });
  return { sha256, size: bytes.length, type: "text/markdown; charset=utf-8" };
}

const titleSchema = z.string().trim().min(1, "A page needs a title.").max(200, "A title is at most 200 characters.");

/** A new Markdown page, in a project (the owner, or its editors) and optionally under a page of it. */
pages.post("/new", requireViewer("viewer", true), requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody();
  const title = titleSchema.safeParse(typeof form["title"] === "string" ? form["title"] : "");
  if (!title.success) return c.text(title.error.issues[0]!.message, 400);
  const parentId = typeof form["parent"] === "string" && form["parent"] ? form["parent"] : undefined;
  const parent = parentId ? await getArtifact(c.env.DB, parentId) : undefined;
  if (parentId && !parent) return c.text("The page to put it under no longer exists.", 400);
  const project = parent ? parent.project : typeof form["project"] === "string" && form["project"] ? form["project"] : null;
  if (project !== null && !projectSchema.safeParse(project).success) return c.text("That is not a project name.", 400);
  if (!(await canSeeProject(c.env.DB, viewer, project)) || !(await canEditProject(c.env.DB, viewer, project))) {
    return c.text("Only the owner and this project's editors can add pages to it.", 403);
  }
  // A page under another one takes on its restrictions, so it needs a parent its writer may change.
  if (parent && !(await canEditPage(c.env.DB, viewer, parent))) return c.text("Only the people who may change that page can add pages under it.", 403);
  // What it starts from: a built-in template, or a template page of the same project.
  const chosen = typeof form["template"] === "string" ? form["template"] : "blank";
  let markdown: string;
  let labels: string[];
  if (chosen.startsWith("page:")) {
    const source = await getArtifact(c.env.DB, chosen.slice(5));
    const sourceVersion = source && source.project === project && (await canSeePage(c.env.DB, viewer, source)) ? await getVersion(c.env.DB, source.id, source.current_version) : null;
    const file = sourceVersion?.entry.endsWith(".md") ? sourceVersion.files[sourceVersion.entry] : undefined;
    const text = file ? await (await c.env.BLOBS.get(blobKey(file.sha256)))?.text() : undefined;
    if (!source || text === undefined) return c.text("That template is not a Markdown page of this project.", 400);
    markdown = fromTemplatePage(text, title.data);
    labels = ((await labelsOf(c.env.DB, [source.id])).get(source.id) ?? []).filter((l) => l !== TEMPLATE_LABEL);
  } else {
    const template = BUILT_IN_TEMPLATES.find((t) => t.id === chosen) ?? BUILT_IN_TEMPLATES[0]!;
    markdown = template.body(title.data, new Date().toISOString().slice(0, 10));
    labels = template.labels;
  }
  const id = randomId();
  await createArtifact(c.env.DB, id, {
    title: title.data,
    description: undefined,
    project: project ?? undefined,
    parent: parent?.id,
    entry: "index.md",
    files: { "index.md": await storeMarkdown(c, markdown) },
    allowConnect: [],
    deviceId: await browserDevice(c),
    text: markdown,
    links: markdownLinks(markdown, c.get("config").origin),
    labels,
  });
  await recordViewerAction(c, "artifact.create", "artifact", id, { version: 1, browser: true });
  indexLater(semanticEnv(c.env), c.executionCtx, id);
  await record(c.env.DB, { artifactId: id, project, kind: "created", actor: { userId: viewer.userId, name: viewer.name }, version: 1 });
  await setWatch(c.env.DB, viewer.userId, pageTarget(id), true);
  return c.redirect(`/a/${id}/edit`, 303);
});

const EDIT_STYLES = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 400 var(--text-sm)/1.4 var(--font-sans); }
.bar { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
.bar input[name=title] { flex: 1; min-width: 180px; font: 600 var(--text-md) var(--font-sans); padding: 6px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.bar select, .bar button, .bar a.btn { font: inherit; padding: 6px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); text-decoration: none; cursor: pointer; }
.bar button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text, #fff); }
.status { color: var(--text-2); min-width: 0; }
.status.error { color: var(--negative, #c0362c); }
.who { color: var(--accent); font-weight: 600; min-width: 0; }
iframe { flex: 1; width: 100%; border: 0; background: #fff; }
@media (prefers-color-scheme: dark) { iframe { background: #1c1c1b; } }
`;

/** Who may write a page in the browser: it is Markdown, and the viewer is the owner or an editor of its project. */
async function writable(c: Context<AppEnv>, id: string): Promise<{ artifact: ArtifactRow; version: VersionRow } | Response> {
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const version = await getVersion(c.env.DB, id, artifact.current_version);
  if (!version) return c.notFound();
  if (!version.entry.endsWith(".md")) {
    return c.text("This page is HTML that an agent wrote. Ask the agent to change it, or leave a comment on it.", 400);
  }
  return { artifact, version };
}

pages.get("/a/:id/edit", requireViewer("viewer", true), async (c) => {
  const id = c.req.param("id");
  const found = await writable(c, id);
  if (found instanceof Response) return found;
  const { artifact, version } = found;
  const viewer = c.get("viewer");
  // Only the pages this person may see are offered, to link to, to list or to embed.
  const access = await accessFor(c.env.DB, viewer);
  const tree = artifact.project ? (await listProjectPages(c.env.DB, artifact.project)).filter((r) => !access.hiddenPages.has(r.id)) : [];
  const { token } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version, undefined, viewer.userId);
  const [inUse, embeddable] = await Promise.all([
    labelCounts(c.env.DB, access),
    markdownPages(c.env.DB, artifact.project).then((rows) => rows.filter((r) => r.id !== id && !access.hiddenPages.has(r.id))),
  ]);
  const nonce = c.get("nonce");
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Editing ${artifact.title}`}</title>
        <style>{raw(TOKENS + EDIT_STYLES)}</style>
      </head>
      <body>
        <div class="bar">
          <input name="title" id="title" value={artifact.title} maxlength={200} aria-label="Title" />
          {tree.length > 1 && (
            <select id="link" aria-label="Insert a link to a page">
              <option value="">Link to a page…</option>
              {tree
                .filter((r) => r.id !== id)
                .map((r) => (
                  <option value={r.id}>{r.title}</option>
                ))}
            </select>
          )}
          <select id="insert" aria-label="Insert a list or another page">
            <option value="">Insert…</option>
            <option value="{{toc}}">Table of contents</option>
            <option value="{{children}}">Pages under this one</option>
            <option value="{{recent}}">Recently changed pages</option>
            {inUse.length > 0 && (
              <optgroup label="Pages with a label">
                {inUse.slice(0, 40).map((l) => (
                  <option value={`{{label ${l.label}}}`}>{l.label}</option>
                ))}
              </optgroup>
            )}
            {embeddable.length > 0 && (
              <optgroup label="Embed a page">
                {embeddable.slice(0, 100).map((p) => (
                  <option value={`{{include /a/${p.id}}}`}>{p.title}</option>
                ))}
              </optgroup>
            )}
          </select>
          <span class="status" id="status" aria-live="polite">
            Editing v{version.version}
          </span>
          <span class="who" id="who" aria-live="polite" hidden />
          <a class="btn" href={`/a/${id}`}>
            Cancel
          </a>
          <button type="button" id="save" class="primary">
            Save
          </button>
        </div>
        <iframe id="editor" src={`/c/${token}/${EDITOR_PATH}`} sandbox={SANDBOX_FLAGS} title="Editor" />
        <script nonce={nonce}>
          {raw(`
const frame = document.getElementById("editor"), status = document.getElementById("status");
const titles = ${jsonInScript(Object.fromEntries(tree.map((r) => [r.id, r.title])))};
let base = ${version.version}, waiting = null;
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === "artifact:markdown" && waiting && typeof d.markdown === "string") { waiting(d.markdown); waiting = null; }
});
const markdown = () => new Promise((ok, fail) => {
  waiting = ok;
  frame.contentWindow.postMessage({ type: "artifact:get" }, "*");
  setTimeout(() => { if (waiting) { waiting = null; fail(new Error("The editor did not answer.")); } }, 5000);
});
// A macro goes on a line of its own; the page fills it in when it is shown.
const insert = document.getElementById("insert");
insert.addEventListener("change", () => {
  if (!insert.value) return;
  frame.contentWindow.postMessage({ type: "artifact:insert", text: "\\n" + insert.value + "\\n" }, "*");
  insert.value = "";
});
const link = document.getElementById("link");
if (link) link.addEventListener("change", () => {
  if (!link.value) return;
  frame.contentWindow.postMessage({ type: "artifact:insert", text: "[" + titles[link.value].replace(/[\\[\\]]/g, "") + "](/a/" + link.value + ")" }, "*");
  link.value = "";
});
const headers = { "content-type": "application/json", "x-csrf": ${JSON.stringify(viewer.csrf)} };
const presence = ${JSON.stringify(`/a/${id}/presence`)};
// While this editor is open it says so, and hears who else edits and what was saved meanwhile.
const who = document.getElementById("who");
const beat = async () => {
  try {
    const res = await fetch(presence, { method: "POST", credentials: "same-origin", headers, body: "{}" });
    if (!res.ok) return;
    const s = await res.json();
    const parts = [];
    if (s.editing.length) parts.push(s.editing.join(", ") + (s.editing.length === 1 ? " is" : " are") + " editing too");
    if (s.version > base) parts.push("v" + s.version + " was saved meanwhile: saving merges your changes into it");
    who.textContent = parts.join(" · ");
    who.hidden = parts.length === 0;
  } catch {}
};
beat();
setInterval(beat, ${BEAT_SECONDS * 1000});
addEventListener("pagehide", () => { fetch(presence, { method: "DELETE", credentials: "same-origin", headers, keepalive: true }).catch(() => {}); });
document.getElementById("save").addEventListener("click", async () => {
  status.className = "status"; status.textContent = "Saving…";
  try {
    const body = JSON.stringify({ base_version: base, title: document.getElementById("title").value, markdown: await markdown(), merge: true });
    const res = await fetch(location.pathname, { method: "POST", credentials: "same-origin", headers, body });
    const out = await res.json().catch(() => ({}));
    if (res.ok) { location.href = ${JSON.stringify(`/a/${id}`)}; return; }
    status.className = "status error";
    if (res.status === 409 && typeof out.merged === "string") {
      // Both changed the same lines: the merge, with both sides marked, goes into the editor.
      base = out.current_version;
      frame.contentWindow.postMessage({ type: "artifact:set", markdown: out.merged, mode: "markdown" }, "*");
      status.textContent = (out.conflicts === 1 ? "1 part" : out.conflicts + " parts") + " changed both by you and in v" + out.current_version + " by " + out.by
        + ". Both are marked in the text: keep what should stay, delete the <<<<<<<, ======= and >>>>>>> lines, and save.";
      who.hidden = true;
      return;
    }
    status.textContent = res.status === 409
      ? "Version " + out.current_version + " was saved meanwhile by " + (out.by || "someone") + " and could not be merged. Copy your text, reload, and add your change to it."
      : (out.error || "Saving failed.");
  } catch (e) { status.className = "status error"; status.textContent = e.message; }
});`)}
        </script>
      </body>
    </html>,
  );
});

const saveSchema = z.object({ base_version: z.number().int().positive(), title: titleSchema, markdown: z.string(), merge: z.boolean().optional() });

/** The Markdown of a version of a page written in Markdown. */
async function markdownOf(c: Context<AppEnv>, id: string, version: number): Promise<string | undefined> {
  const row = await getVersion(c.env.DB, id, version);
  const file = row?.entry.endsWith(".md") ? row.files[row.entry] : undefined;
  return file ? await (await c.env.BLOBS.get(blobKey(file.sha256)))?.text() : undefined;
}

/** Who saved a version: the person, or the agent's device. */
async function savedBy(c: Context<AppEnv>, id: string, version: number): Promise<string> {
  const row = await c.env.DB.prepare("select d.name from versions v join devices d on d.id = v.created_by where v.artifact_id = ? and v.version = ?")
    .bind(id, version)
    .first<{ name: string }>();
  return (row?.name ?? "someone").replace(/ \(browser\)$/, "");
}

/** Saves a page written in the browser as a new version. */
pages.post("/a/:id/edit", requireViewer("viewer", true), requireSameOriginJson(), async (c) => {
  const id = c.req.param("id");
  const found = await writable(c, id);
  if (found instanceof Response) return found instanceof Response && found.status < 500 ? c.json({ error: await found.text() }, found.status as 400) : found;
  const { artifact, version } = found;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "The request is not JSON." }, 400);
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
  const { base_version, title } = parsed.data;
  let { markdown } = parsed.data;
  let base = base_version;
  let merged = false;
  if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES) return c.json({ error: "A page is at most 1 MB of text." }, 413);
  if (base_version !== artifact.current_version) {
    // Saved meanwhile: merge this text into the latest, when asked to and when both can be read.
    const latest = artifact.current_version;
    const [was, now] = parsed.data.merge ? await Promise.all([markdownOf(c, id, base_version), markdownOf(c, id, latest)]) : [];
    const by = await savedBy(c, id, latest);
    const result = was !== undefined && now !== undefined ? merge3(was, markdown, now, { mine: "your text", theirs: `v${latest} by ${by}` }) : undefined;
    if (!result || result.conflicts > 0) {
      return c.json({ error: "version_conflict", current_version: latest, by, ...(result ? { merged: result.text, conflicts: result.conflicts } : {}) }, 409);
    }
    markdown = result.text;
    base = latest;
    merged = true;
  }
  if (hasConflictMarks(markdown) && parsed.data.merge) return c.json({ error: "The text still has conflict marks (<<<<<<< and >>>>>>>). Keep what should stay and remove them." }, 400);
  const added = await addVersion(c.env.DB, id, base, {
    title,
    description: artifact.description ?? undefined,
    entry: version.entry,
    files: { ...version.files, [version.entry]: await storeMarkdown(c, markdown) },
    allowConnect: version.allow_connect,
    deviceId: await browserDevice(c),
    text: markdown.slice(0, MAX_TEXT_CHARS),
    links: markdownLinks(markdown, c.get("config").origin),
  });
  if (!added) return c.json({ error: "version_conflict", current_version: (await getArtifact(c.env.DB, id))?.current_version ?? base + 1 }, 409);
  await recordViewerAction(c, "artifact.update", "artifact", id, { version: base + 1, browser: true, merged });
  indexLater(semanticEnv(c.env), c.executionCtx, id);
  const viewer = c.get("viewer");
  await record(c.env.DB, { artifactId: id, project: artifact.project, kind: "updated", actor: { userId: viewer.userId, name: viewer.name }, version: base + 1 });
  await setWatch(c.env.DB, viewer.userId, pageTarget(id), true);
  await leave(c.env.DB, id, viewer.userId);
  return c.json({ version: base + 1, merged });
});


/** An open editor says it is still open; the answer says who else edits and the latest version. */
pages.post("/a/:id/presence", requireViewer("viewer", true), requireSameOriginJson(), async (c) => {
  const id = c.req.param("id");
  const found = await writable(c, id);
  if (found instanceof Response) return c.json({ error: "not allowed" }, 403);
  const viewer = c.get("viewer");
  await beat(c.env.DB, id, viewer);
  return c.json({ version: found.artifact.current_version, editing: await editing(c.env.DB, id, viewer.userId), every: BEAT_SECONDS });
});

pages.delete("/a/:id/presence", requireViewer("viewer", true), requireSameOriginJson(), async (c) => {
  await leave(c.env.DB, c.req.param("id"), c.get("viewer").userId);
  return c.json({ ok: true });
});

/** For an open page: its latest version and who is editing it, so the viewer can say so. */
pages.get("/a/:id/state", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.json({ error: "not found" }, 404);
  const latest = artifact.current_version;
  return c.json({ version: latest, by: await savedBy(c, id, latest), editing: await editing(c.env.DB, id, viewer.userId) });
});

// --- Comments ---

const commentForm = [requireViewer("viewer", true), requireSameOriginForm()] as const;

/** A comment on a page, or a reply in one of its threads; a passage quoted from the page starts a thread on it. */
pages.post("/a/:id/comments", ...commentForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
  const form = await c.req.parseBody();
  const body = typeof form["body"] === "string" ? form["body"].trim() : "";
  if (!body || body.length > MAX_COMMENT_CHARS) return c.text(`A comment is 1 to ${MAX_COMMENT_CHARS} characters.`, 400);
  const replyTo = typeof form["reply_to"] === "string" && form["reply_to"] ? form["reply_to"] : null;
  if (replyTo) {
    const first = await getComment(c.env.DB, replyTo);
    if (!first || first.artifact_id !== id || first.reply_to) return c.text("That thread is not on this page.", 400);
  }
  const quote = !replyTo && typeof form["quote"] === "string" && form["quote"].trim() ? form["quote"].replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE_CHARS) : null;
  const cid = await addComment(c.env.DB, {
    artifact_id: id, version: artifact.current_version, reply_to: replyTo,
    author_user: viewer.userId, author_device: null, author_name: viewer.name, body, quote,
  });
  await recordViewerAction(c, "comment.create", "artifact", id, { comment: cid, reply: !!replyTo });
  // Mentions come from the box's suggestions as user ids; only people still named in the text count.
  const named = typeof form["mentions"] === "string" ? form["mentions"].split(",").filter(Boolean).slice(0, 20) : [];
  const people = named.length ? (await c.env.DB.prepare(`select id, name from users where id in (${named.map(() => "?").join(", ")})`).bind(...named).all<{ id: string; name: string }>()).results : [];
  const mentions = people.filter((u) => body.includes(`@${u.name}`)).map((u) => u.id);
  await record(c.env.DB, {
    artifactId: id, project: artifact.project, kind: replyTo ? "replied" : "commented",
    actor: { userId: viewer.userId, name: viewer.name }, commentId: replyTo ?? cid, mentions,
    thread: replyTo ? await threadPeople(c.env.DB, replyTo) : [],
  });
  await setWatch(c.env.DB, viewer.userId, pageTarget(id), true);
  return c.redirect(`/a/${id}?comments=1#c-${replyTo ?? cid}`, 303);
});

/** The owner, the project's editors, and whoever started a thread may settle it. */
async function mayManage(c: Context<AppEnv>, artifact: ArtifactRow, comment: CommentRow, action: "settle" | "delete"): Promise<boolean> {
  const viewer = c.get("viewer");
  if (viewer.role === "root" || comment.author_user === viewer.userId) return true;
  return action === "settle" && (await canEditPage(c.env.DB, viewer, artifact));
}

pages.post("/a/:id/comments/:cid/resolve", ...commentForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  const comment = await getComment(c.env.DB, c.req.param("cid"));
  if (!artifact || !comment || comment.artifact_id !== id || comment.reply_to || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.notFound();
  if (!(await mayManage(c, artifact, comment, "settle"))) return c.text("Only the owner, the project's editors and the thread's author can settle it.", 403);
  const form = await c.req.parseBody();
  const resolved = form["resolved"] !== "0";
  await setResolved(c.env.DB, comment.id, resolved);
  if (resolved) {
    const viewer = c.get("viewer");
    await record(c.env.DB, { artifactId: id, project: artifact.project, kind: "resolved", actor: { userId: viewer.userId, name: viewer.name }, commentId: comment.id, thread: await threadPeople(c.env.DB, comment.id) });
  }
  return c.redirect(`/a/${id}?comments=1#c-${comment.id}`, 303);
});

pages.post("/a/:id/comments/:cid/delete", ...commentForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  const comment = await getComment(c.env.DB, c.req.param("cid"));
  if (!artifact || !comment || comment.artifact_id !== id || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.notFound();
  if (!(await mayManage(c, artifact, comment, "delete"))) return c.text("Only the owner and the comment's author can delete it.", 403);
  await deleteComment(c.env.DB, comment.id);
  await recordViewerAction(c, "comment.delete", "artifact", id, { comment: comment.id });
  return c.redirect(`/a/${id}?comments=1`, 303);
});


// --- Activity, watches and notifications ---

const ACTIVITY_STYLES = `
.feed { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.feed li { display: flex; gap: var(--space-2); align-items: baseline; flex-wrap: wrap; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.feed li.unread { font-weight: 600; }
.feed li.unread::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex-shrink: 0; align-self: center; }
.feed .why { font-size: var(--text-xs); }
.feed .when { color: var(--text-2); font-size: var(--text-sm); margin-left: auto; font-weight: 400; }
`;

const VERB: Record<ActivityRow["kind"], string> = {
  created: "made",
  updated: "changed",
  commented: "commented on",
  replied: "replied on",
  resolved: "resolved a thread on",
};

/** "Alex changed Handbook (v3)", linking to the page or its comment. */
function ActivityLine(props: { a: ActivityRow; href?: string; project?: boolean }) {
  const { a } = props;
  return (
    <>
      <span>
        {a.actor_name}
        {a.actor_device && <span class="muted"> (agent)</span>} {VERB[a.kind]}{" "}
        <a href={props.href ?? activityHref(a)}>{a.title}</a>
        {(a.kind === "updated" || a.kind === "created") && a.version !== null && <span class="muted"> v{a.version}</span>}
      </span>
      {props.project && a.project && <span class="badge">{a.project}</span>}
    </>
  );
}

const REASON: Record<string, string> = { mentioned: "mentioned you", thread: "in your thread", watching: "watching" };

pages.get("/notifications", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const access = await accessFor(c.env.DB, viewer);
  const rows = (await listNotifications(c.env.DB, viewer.userId)).filter((n) => access.sees({ id: n.artifact_id, project: n.page_project }));
  return c.html(
    <Page title="Notifications" viewer={viewer}>
      <style>{raw(ACTIVITY_STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>Notifications</h1>
          <p class="lead">What happened on pages you watch, in threads you wrote in, and where someone mentioned you.</p>
        </div>
        {viewer.unread > 0 && viewer.sessionKind === "full" && (
          <form method="post" action="/notifications/read">
            <CsrfField token={viewer.csrf} />
            <button type="submit">Mark all as read</button>
          </form>
        )}
      </div>
      {rows.length === 0 ? (
        <p class="muted">Nothing yet. Watch a page or a project to hear about its changes and comments.</p>
      ) : (
        <ul class="feed">
          {rows.map((n) => (
            <li class={n.read_at ? undefined : "unread"}>
              <ActivityLine a={n} href={`/notifications/${n.notification_id}/open`} project />
              <span class="badge why">{REASON[n.reason]}</span>
              <span class="when">
                <Time iso={n.at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Page>,
  );
});

/** Opens what a notification is about and marks it read. */
pages.get("/notifications/:nid/open", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const row = (await listNotifications(c.env.DB, viewer.userId, 500)).find((n) => n.notification_id === c.req.param("nid"));
  if (!row) return c.redirect("/notifications", 303);
  // Reading changes nothing else, so a view-only session may mark it too.
  await markRead(c.env.DB, viewer.userId, row.notification_id);
  return c.redirect(activityHref(row), 303);
});

pages.post("/notifications/read", requireViewer("viewer", true), requireSameOriginForm(), async (c) => {
  await markRead(c.env.DB, c.get("viewer").userId);
  return c.redirect("/notifications", 303);
});

pages.get("/activity", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const access = await accessFor(c.env.DB, viewer);
  const rows = (await listActivity(c.env.DB, { limit: 100 })).filter((a) => access.sees({ id: a.artifact_id, project: a.page_project }));
  return c.html(
    <Page title="Activity" viewer={viewer}>
      <style>{raw(ACTIVITY_STYLES)}</style>
      <h1>Activity</h1>
      <p class="lead">What changed lately, on every page you can see.</p>
      <ul class="feed">
        {rows.map((a) => (
          <li>
            <ActivityLine a={a} project />
            <span class="when">
              <Time iso={a.at} />
            </span>
          </li>
        ))}
      </ul>
    </Page>,
  );
});

/** Starts or stops watching a page or a project. */
pages.post("/watch", requireViewer("viewer", true), requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody();
  const page = typeof form["page"] === "string" ? form["page"] : "";
  const project = typeof form["project"] === "string" ? form["project"] : "";
  const on = form["on"] !== "0";
  if (page) {
    const artifact = await getArtifact(c.env.DB, page);
    if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
    await setWatch(c.env.DB, viewer.userId, pageTarget(page), on);
    return c.redirect(`/a/${page}`, 303);
  }
  if (!project || !projectSchema.safeParse(project).success || !(await canSeeProject(c.env.DB, viewer, project))) return c.notFound();
  await setWatch(c.env.DB, viewer.userId, projectTarget(project), on);
  return c.redirect(projectHref(project), 303);
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
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
  if (!(await canEditPage(c.env.DB, viewer, artifact))) return c.text("Only the owner, this project's editors and the people this page lets edit it can change it.", 403);
  return artifact;
}

/** Who may see and change a page: open, only some edit, or only some view (the pages under it too). */
pages.post("/a/:id/access", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const value = (await c.req.parseBody())["restriction"];
  const restriction = value === "edit" || value === "view" ? value : null;
  await setRestriction(c.env.DB, id, restriction, c.get("viewer"));
  await recordViewerAction(c, "artifact.restrict", "artifact", id, { restriction });
  return c.redirect(`/a/${id}?access=1`, 303);
});

pages.post("/a/:id/access/people", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const form = await c.req.parseBody();
  const user = typeof form["user"] === "string" ? form["user"] : "";
  const can = form["can"] === "view" ? "view" : "edit";
  // A restriction only narrows the project's rules: only people who may see the project count.
  if (!(await peopleWhoCanSee(c.env.DB, artifact.project)).some((p) => p.id === user)) return c.text("That person cannot see this project.", 400);
  await setAccess(c.env.DB, id, user, can);
  await recordViewerAction(c, "artifact.access", "artifact", id, { user, can });
  return c.redirect(`/a/${id}?access=1`, 303);
});

pages.post("/a/:id/access/remove", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const viewer = c.get("viewer");
  const user = (await c.req.parseBody())["user"];
  if (typeof user !== "string" || !user) return c.text("Whom to take off?", 400);
  if (user === viewer.userId && viewer.role !== "root") return c.text("You cannot take yourself off. Open the page to everyone, or ask the owner.", 400);
  await setAccess(c.env.DB, id, user, null);
  await recordViewerAction(c, "artifact.access", "artifact", id, { user, can: null });
  return c.redirect(`/a/${id}?access=1`, 303);
});

/** Adds labels to a page: words separated by commas (or spaces). */
pages.post("/a/:id/labels", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const form = await c.req.parseBody();
  const words = (typeof form["add"] === "string" ? form["add"] : "").split(/[,\s]+/).filter(Boolean);
  const parsed = labelsSchema.safeParse(words);
  if (!parsed.success || parsed.data.length === 0) return c.text(`Not a label: a label is one word of letters, digits, - and _ (at most 30 characters, ${MAX_LABELS} per page).`, 400);
  const labels = await changeLabels(c.env.DB, id, { add: parsed.data });
  await recordViewerAction(c, "artifact.labels", "artifact", id, { labels: labels.length });
  return c.redirect(`/a/${id}?labels=1`, 303);
});

pages.post("/a/:id/labels/remove", ...editorForm, async (c) => {
  const id = c.req.param("id");
  const artifact = await editable(c, id);
  if (artifact instanceof Response) return artifact;
  const form = await c.req.parseBody();
  const label = labelSchema.safeParse(typeof form["label"] === "string" ? form["label"] : "");
  if (!label.success) return c.text("No such label.", 400);
  const labels = await changeLabels(c.env.DB, id, { remove: [label.data] });
  await recordViewerAction(c, "artifact.labels", "artifact", id, { labels: labels.length });
  return c.redirect(`/a/${id}?labels=1`, 303);
});

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
  if (parent && !(await canEditPage(c.env.DB, c.get("viewer"), { id: parent, project: artifact.project }))) {
    return c.text("Only the people who may change that page can put pages under it.", 403);
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
  const src = frameSrc(token, version.entry);
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
  return c.json({ src: frameSrc(token, version.entry), exp });
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
  const semantic = semanticOn(semanticEnv(c.env));
  const pending = semantic ? await pendingPages(c.env.DB, 0) : { ids: [], left: 0, total: 0 };
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

      <section class="section" id="search">
        <div class="section-head">
          <div>
            <h2>Search by meaning</h2>
            <p class="muted small" style="margin:0">
              {semantic
                ? `Pages are found by meaning as well as by their words. ${pending.total - pending.left} of ${pending.total} pages are indexed; a page is indexed again when it changes.`
                : "Off: the Worker has no Workers AI or Vectorize binding. Search goes by words."}
            </p>
          </div>
          {semantic && pending.left > 0 && (
            <button type="button" id="index-pages" class="primary">
              Index {pending.left} {pending.left === 1 ? "page" : "pages"}
            </button>
          )}
        </div>
        {semantic && pending.left > 0 && (
          <>
            <p class="muted small" id="index-status" aria-live="polite">
              Pages published before this was added are indexed {INDEX_BATCH} at a time, and the daily cleanup indexes some as well.
              Pages from before search kept their text need <code>artifact reindex</code> first.
            </p>
            <script nonce={c.get("nonce")}>
              {raw(`
const button = document.getElementById("index-pages"), status = document.getElementById("index-status");
button.addEventListener("click", async () => {
  button.disabled = true;
  for (;;) {
    const res = await fetch("/settings/search/index", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf": ${jsonInScript(viewer.csrf)} }, body: "{}" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { status.textContent = out.error || "Indexing failed."; button.disabled = false; return; }
    status.textContent = (out.total - out.left) + " of " + out.total + " pages indexed.";
    if (out.left === 0 || out.indexed === 0) { button.textContent = "Done"; return; }
  }
});`)}
            </script>
          </>
        )}
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

/** Indexes the next pages for search by meaning; the settings page calls it until none are left. */
root.post("/settings/search/index", requireSameOriginJson(), async (c) => {
  const env = semanticEnv(c.env);
  if (!semanticOn(env)) return c.json({ error: "Search by meaning is off." }, 400);
  try {
    return c.json(await indexPending(env));
  } catch (e) {
    return c.json({ error: `Workers AI or Vectorize refused: ${String(e).slice(0, 200)}. On the free plan the daily allowance may be used up; try tomorrow.` }, 503);
  }
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
