import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../app-env.ts";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { passkeyLabel, registrationOptions, takeCeremony, verifyRegistration } from "../auth/passkeys.ts";
import { requireSameOriginForm, requireSameOriginJson, requireViewer } from "../auth/session.ts";
import { SANDBOX_FLAGS, mintContentToken, renewContentLease, signedContentClaims } from "../content.ts";
import { EDITOR_PATH, frameSrc, markdownLinks } from "../doc.ts";
import { MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, addComment, deleteComment, getComment, listComments, openThreadCounts, setResolved, threadPeople, threadsOf, type CommentRow, type Thread } from "../db/comments.ts";
import { changeLabels, labelCounts, labeledSearch, labelsOf } from "../db/labels.ts";
import { BEAT_SECONDS, beat, editing, leave } from "../db/presence.ts";
import { hasConflictMarks, merge3 } from "../merge.ts";
import { MAX_SOURCE_BYTES, SOURCE_PATH, editableFiles } from "../source.ts";
import { BUILT_IN_TEMPLATES, TEMPLATE_LABEL, fromTemplatePage, markdownPages, type MarkdownPage } from "../templates.ts";
import { activityHref, listActivity, listNotifications, markRead, markSeen, pageTarget, projectTarget, record, setWatch, watching, type ActivityRow } from "../db/activity.ts";
import { MAX_TEXT_CHARS, type VersionFile, labelSchema, labelsSchema, MAX_LABELS, pageText, pageLinks } from "@artifact/shared";
import { revokeMembersOfDevice } from "../db/vault.ts";
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
  HOME_LABEL,
  homeOf,
  homePages,
  listProjectStats,
  versionAuthors,
  BROWSER_DEVICE_PREFIX,
  type ArtifactRow,
  type TreeRow,
  type ProjectStats,
  type VersionAuthor,
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
import { COMMENTS, PANELS, VIEWER, WHO } from "../words/viewer.tsx";
import { LIST } from "../words/list.tsx";

export const pages = new Hono<AppEnv>();

/** A value written into an inline script: as JSON that cannot end the script element early (</script>) or a line (U+2028). */
function jsonInScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Runs right after the frame, before its first page has loaded: a #fragment in the address bar
 * (a link to a place in the page) goes to the page in the frame from its start.
 */
const FRAGMENT_INTO_FRAME = `if (location.hash) { const f = document.getElementById("frame"); f.src = f.getAttribute("src") + location.hash; }`;

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
.label-strip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); margin: 0 0 var(--space-4); }
.label-strip .muted { margin-right: var(--space-1); }
.rows .chip { vertical-align: 1px; }
.up { display: inline-block; font-size: var(--text-sm); color: var(--text-2); margin-bottom: var(--space-2); }
.up:hover { color: var(--text); }
.spaces { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); margin: 0 0 var(--space-6); }
.space { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); text-decoration: none; min-height: 112px; }
.space:hover { border-color: var(--accent); text-decoration: none; }
.space h2 { font-size: var(--text-md); font-weight: 650; overflow-wrap: anywhere; }
.space p { margin: 0; color: var(--text-2); font-size: var(--text-sm); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.space .meta { margin-top: auto; color: var(--text-2); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.space.loose { background: transparent; border-style: dashed; }
.section-title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); margin: 0 0 var(--space-3); }
.section-title h2 { font-size: var(--text-md); }
.section-title a { font-size: var(--text-sm); }
.more-link { display: inline-block; margin-top: var(--space-4); font-size: var(--text-sm); }
.head-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin: 0 0 var(--space-4); }
.head-actions form { margin: 0; }
.head-actions .grow { flex: 1; }
.new-page { margin: 0 0 var(--space-4); }
.new-page > summary { display: inline-flex; list-style: none; cursor: pointer; }
.new-page > summary::-webkit-details-marker { display: none; }
.new-page[open] > summary { margin-bottom: var(--space-3); }
.new-page form { display: grid; gap: var(--space-2); grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; padding: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.new-page select { font: inherit; font-size: var(--text-sm); padding: 7px var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); width: 100%; }
.new-page label { margin: 0; }
@media (max-width: 640px) { .new-page form { grid-template-columns: 1fr; } }
.read-only { margin: 0 0 var(--space-4); color: var(--text-2); font-size: var(--text-sm); }
`;

/** `/?project=<name>` one project's pages; `/?project=` the pages without one. */
function projectHref(project: string | null): string {
  return `/?project=${encodeURIComponent(project ?? "")}`;
}

/**
 * `/` is the list of projects (each leading to its front page) with what changed lately;
 * `/?all=1` every page, newest first; `/?label=x` the pages with a label (in a project with
 * `&project=`); `/?project=x` one project's pages as a tree; `/?project=` those without one.
 */
pages.get("/", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const t = LIST;
  const query = c.req.query("project");
  const selected = query === undefined ? undefined : query.trim() || null;
  const wanted = labelSchema.safeParse(c.req.query("label") ?? "");
  const label = wanted.success ? wanted.data : undefined;
  const all = c.req.query("all") === "1";
  const access = await accessFor(c.env.DB, viewer);
  const hidden = access.hiddenProjects;
  const blocked = typeof selected === "string" && hidden.has(selected);
  const [stats, homes] = await Promise.all([listProjectStats(c.env.DB), homePages(c.env.DB, access.hiddenPages)]);
  // Pages hidden by a restriction are not counted either.
  const projects = visibleProjects(stats, access);
  const total = projects.reduce((n, p) => n + p.count, 0);
  const front = (p: string | null) => (p && homes.get(p) ? `/a/${homes.get(p)!.id}` : projectHref(p));

  // The start: one card per project, then the latest changes.
  if (selected === undefined && !label && !all) {
    const [latest, inUse, open] = await Promise.all([listArtifacts(c.env.DB, 40), labelCounts(c.env.DB, access), openThreadCounts(c.env.DB)]);
    const recent = latest.filter((a) => access.sees(a)).slice(0, 12);
    const named = projects.filter((p) => p.project !== null).sort((a, b) => a.project!.localeCompare(b.project!));
    const loose = projects.find((p) => p.project === null);
    const spaces = await listSpaceDescriptions(c.env.DB);
    return c.html(
      <Page title="Artifacts" viewer={viewer}>
        <style>{raw(PROJECT_STYLES + TREE_STYLES)}</style>
        <div class="page-head">
          <div>
            <h1>{t.site}</h1>
            <p class="lead">{t.directoryLead(named.length, total)}</p>
          </div>
        </div>
        {total === 0 ? (
          <div class="card">
            <h2>{t.nothingYet}</h2>
            <p class="muted small" style="margin:var(--space-2) 0 0">
              {t.nothingBody(<code>artifact</code>)}
            </p>
          </div>
        ) : (
          <>
            <nav class="spaces" aria-label={t.projects}>
              {named.map((p) => (
                <a class="space" href={front(p.project)}>
                  <h2>{p.project}</h2>
                  {spaces.get(p.project!) && <p>{spaces.get(p.project!)}</p>}
                  <span class="meta">
                    {t.pages(p.count)} · {t.updated(<Time iso={p.updated_at} />)}
                  </span>
                </a>
              ))}
              {loose && (
                <a class="space loose" href={projectHref(null)}>
                  <h2>{t.noProject}</h2>
                  <p>{t.noProjectNote}</p>
                  <span class="meta">
                    {t.pages(loose.count)} · {t.updated(<Time iso={loose.updated_at} />)}
                  </span>
                </a>
              )}
            </nav>
            <section>
              <div class="section-title">
                <h2>{t.recent}</h2>
                <a href="/activity">{t.allActivity}</a>
              </div>
              <PageRows rows={recent} showProject open={open} />
              <a class="more-link" href="/?all=1">
                {t.allPages(total)}
              </a>
            </section>
            <LabelStrip labels={inUse} />
          </>
        )}
      </Page>,
    );
  }

  // One project as a tree (no label chosen), with what its space says about itself.
  if (selected !== undefined && !label) {
    const [allTree, space, open, inUse] = await Promise.all([
      blocked ? Promise.resolve([] as TreeRow[]) : listProjectPages(c.env.DB, selected),
      typeof selected === "string" ? getSpace(c.env.DB, selected) : Promise.resolve(null),
      openThreadCounts(c.env.DB),
      labelCounts(c.env.DB, access, selected),
    ]);
    const tree = allTree.filter((r) => !access.hiddenPages.has(r.id));
    const labels = await labelsOf(c.env.DB, tree.map((r) => r.id));
    const home = typeof selected === "string" ? homes.get(selected) : undefined;
    const canWrite = typeof selected === "string" && viewer.sessionKind === "full" && (await canEditProject(c.env.DB, viewer, selected));
    const templates = canWrite ? (await markdownPages(c.env.DB, selected, TEMPLATE_LABEL)).filter((r) => !access.hiddenPages.has(r.id)) : [];
    const [projectWatched, recentAll] =
      typeof selected === "string"
        ? await Promise.all([watching(c.env.DB, viewer.userId, [projectTarget(selected)]), listActivity(c.env.DB, { project: selected, limit: 30 })])
        : [new Set<string>(), [] as ActivityRow[]];
    const recent = recentAll.filter((a) => access.sees({ id: a.artifact_id, project: a.page_project })).slice(0, 8);
    const name = selected ?? t.noProject;
    const wantParent = c.req.query("parent");
    return c.html(
      <Page title={`${name} · Artifacts`} viewer={viewer}>
        <style>{raw(PROJECT_STYLES + TREE_STYLES + ACTIVITY_STYLES)}</style>
        <a class="up" href="/">
          {t.backToProjects}
        </a>
        <div class="page-head">
          <div>
            <h1>{home ? t.projectPages(name) : name}</h1>
            <p class="lead">
              {space?.description ? `${space.description} · ` : ""}
              {t.pages(tree.length)}
              {home && (
                <>
                  {" · "}
                  <a href={`/a/${home.id}`}>{t.front(name)}</a>
                </>
              )}
              {typeof selected === "string" && viewer.role === "root" && (
                <>
                  {" · "}
                  <a href={`/projects/${encodeURIComponent(selected)}`}>
                    {space?.access === "members" ? t.members : t.everyone} · {t.settings}
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
        {tree.length === 0 ? (
          <div class="card">
            <p class="muted small" style="margin:0">
              {t.noPageHere} <a href="/">{t.showAll}</a>
            </p>
          </div>
        ) : (
          <>
            <div class="head-actions">
              {typeof selected === "string" && viewer.sessionKind === "full" && (
                <form method="post" action="/watch">
                  <CsrfField token={viewer.csrf} />
                  <input type="hidden" name="project" value={selected} />
                  <input type="hidden" name="on" value={projectWatched.size ? "0" : "1"} />
                  <button type="submit" class={projectWatched.size ? "quiet" : undefined} title={projectWatched.size ? t.stopTitle : t.watchTitle}>
                    {projectWatched.size ? t.watching : t.watch}
                  </button>
                </form>
              )}
              <span class="grow" />
              <input id="filter" class="search" type="search" placeholder={t.filter} aria-label={t.filter} />
            </div>
            {canWrite ? (
              <details class="new-page" id="new" open={wantParent !== undefined}>
                <summary class="button primary">{t.newPage}</summary>
                <form method="post" action="/new">
                  <CsrfField token={viewer.csrf} />
                  <input type="hidden" name="project" value={selected as string} />
                  <div>
                    <label for="new-title">{t.newTitle}</label>
                    <input id="new-title" name="title" type="text" required maxlength={200} />
                  </div>
                  <div>
                    <label for="new-parent">{t.under}</label>
                    <select id="new-parent" name="parent">
                      <option value="-" selected={!home && !wantParent}>
                        {t.top(name)}
                      </option>
                      {parentChoices(tree, "").map((o) => (
                        <option value={o.id} selected={wantParent ? o.id === wantParent : o.id === home?.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label for="new-template">{PANELS.template}</label>
                    <TemplateChoice pages={templates} />
                  </div>
                  <button type="submit" class="primary">
                    {t.startWriting}
                  </button>
                </form>
              </details>
            ) : (
              typeof selected === "string" && viewer.sessionKind === "full" && <p class="read-only">{t.readOnly}</p>
            )}
            <LabelStrip labels={inUse} project={selected} />
            <div class="card">
              <PageTree rows={tree} meta id="artifacts" labels={labels} threads={open} project={selected} />
              <p class="empty muted small" id="no-match" hidden>
                {t.noMatch}
              </p>
            </div>
            {recent.length > 0 && typeof selected === "string" && (
              <section class="section">
                <div class="section-head">
                  <h2>{t.recentActivity}</h2>
                  <a href={`/activity?project=${encodeURIComponent(selected)}`} class="small">
                    {t.allActivity}
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
        )}
      </Page>,
    );
  }

  // Every page, or the pages with a label: a flat list, newest first.
  const [found, inUse, open] = await Promise.all([blocked ? Promise.resolve([]) : listArtifacts(c.env.DB, 200, selected, label), labelCounts(c.env.DB, access, selected), openThreadCounts(c.env.DB)]);
  const rows = found.filter((a) => access.sees(a));
  const clear = selected === undefined ? "/?all=1" : projectHref(selected);
  return c.html(
    <Page title={label ? `${t.labelTitle(label)} · Artifacts` : `${t.allTitle} · Artifacts`} viewer={viewer}>
      <style>{raw(PROJECT_STYLES + TREE_STYLES)}</style>
      <a class="up" href={selected === undefined ? "/" : projectHref(selected)}>
        {selected === undefined ? t.backToProjects : `← ${selected ?? t.noProject}`}
      </a>
      <div class="page-head">
        <div>
          <h1>{label ? t.labelTitle(label) : t.allTitle}</h1>
          <p class="lead">
            {label ? t.labelLead(rows.length, selected) : t.allLead(rows.length)}
            {label && (
              <>
                {" · "}
                <a href={clear} title={t.clearLabelTitle}>
                  {t.clearLabel}
                </a>
              </>
            )}
          </p>
        </div>
        {rows.length > 0 && <input id="filter" class="search" type="search" placeholder={t.filter} aria-label={t.filter} />}
      </div>
      <LabelStrip labels={inUse} project={selected} current={label} />
      {rows.length === 0 ? (
        <div class="card">
          <p class="muted small" style="margin:0">
            {t.noPageHere} <a href="/?all=1">{t.showAll}</a>
          </p>
        </div>
      ) : (
        <>
          <PageRows rows={rows} showProject={selected === undefined} id="artifacts" open={open} />
          <p class="empty muted small" id="no-match" hidden>
            {t.noMatch}
          </p>
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

/** The projects a person can see a page of, with those pages counted (hidden ones are not). */
function visibleProjects(stats: ProjectStats[], access: Access): ProjectStats[] {
  return stats
    .filter((p) => !p.project || !access.hiddenProjects.has(p.project))
    .map((p) => ({ ...p, count: p.count - (access.hiddenPerProject.get(p.project) ?? 0) }))
    .filter((p) => p.count > 0);
}

/** What each project says about itself (its space's description), by name. */
async function listSpaceDescriptions(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("select name, description from spaces where description is not null and description != ''").all<{ name: string; description: string }>();
  return new Map(results.map((r) => [r.name, r.description]));
}

/** The labels in use, each a link to its pages (in the project, when one is given). */
function LabelStrip(props: { labels: { label: string; count: number }[]; project?: string | null; current?: string }) {
  const t = LIST;
  const shown = props.labels.filter((l) => l.label !== HOME_LABEL).sort((a, b) => a.label.localeCompare(b.label));
  if (shown.length === 0) return null;
  const within = props.project === undefined ? "" : `&project=${encodeURIComponent(props.project ?? "")}`;
  return (
    <nav class="label-strip" aria-label={t.labels}>
      <span class="muted small">{t.labels}</span>
      {shown.slice(0, 40).map((l) => (
        <a class={`chip${l.label === props.current ? " current" : ""}`} href={`/?label=${encodeURIComponent(l.label)}${within}`} title={t.labeled(l.label)}>
          {l.label} {l.count}
        </a>
      ))}
    </nav>
  );
}

/** Pages as rows: title, badges, labels, description and when they last changed. */
function PageRows(props: { rows: (ArtifactRow & { allow_connect: string[] })[]; showProject?: boolean; id?: string; open?: Map<string, number> }) {
  const t = LIST;
  return (
    <ul class="rows links" id={props.id}>
      {props.rows.map((a) => (
        <li data-text={`${a.title} ${a.description ?? ""} ${a.project ?? ""}`.toLowerCase()}>
          <div class="main">
            <a class="title" href={`/a/${a.id}`}>
              {a.title}
            </a>{" "}
            {props.showProject && a.project && <span class="badge">{a.project}</span>}{" "}
            {a.allow_connect.length > 0 && (
              <span class="badge warn" title={t.externalTitle(a.allow_connect.join(", "))}>
                {t.external}
              </span>
            )}{" "}
            {shareActive(a) && (
              <span class="badge accent" title={t.publicTitle(formatTime(a.share_expires_at!))}>
                {t.publicBadge}
              </span>
            )}{" "}
            {(props.open?.get(a.id) ?? 0) > 0 && (
              <span class="badge" title={t.openTitle}>
                {t.threads(props.open!.get(a.id)!)}
              </span>
            )}
            {a.description && <div class="desc">{a.description}</div>}
          </div>
          <div class="side">
            <Time iso={a.updated_at} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// --- Viewer ---

const VIEWER_STYLES = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 400 var(--text-sm)/1.4 var(--font-sans); }
a { color: inherit; text-decoration: none; }
.bar { height: 48px; flex-shrink: 0; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); border-bottom: 1px solid var(--border); background: var(--bg); overflow: hidden; }
.divider { width: 1px; height: 20px; background: var(--border); flex: none; }
.crumbs { display: flex; align-items: baseline; gap: var(--space-1); min-width: 6em; flex: 0 1 auto; overflow: hidden; white-space: nowrap; }
.crumbs a { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; max-width: 14em; flex: 0 1 auto; min-width: 2em; }
.crumbs a:hover { color: var(--text); text-decoration: underline; }
.crumbs .sep { color: var(--text-3); flex: none; }
.crumbs .title { font-weight: 650; color: var(--text); overflow: hidden; text-overflow: ellipsis; min-width: 3em; flex: 0 1 auto; }
.meta { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; font-variant-numeric: tabular-nums; }
.badge { font-size: var(--text-xs); font-weight: 600; padding: 1px var(--space-2); border-radius: 999px; background: color-mix(in srgb, var(--warning) 14%, var(--surface)); color: var(--warning); white-space: nowrap; flex: none; }
.badge.public { background: var(--accent-soft); color: var(--accent); }
.spacer { flex: 1 1 0; min-width: var(--space-2); }
.tools { display: flex; align-items: center; gap: var(--space-1); flex: none; }
.tool { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--text-2); padding: 5px var(--space-2); border-radius: var(--radius-sm); cursor: pointer; white-space: nowrap; border: 0; background: none; font: inherit; }
.tool:hover { background: var(--surface-2); color: var(--text); }
.tool.icon { padding: 5px 8px; font-size: var(--text-md); line-height: 1; }
.tool.primary { background: var(--accent); color: var(--accent-text); font-weight: 600; padding: 5px var(--space-3); }
.tool.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--text)); color: var(--accent-text); }
.tool.on { color: var(--accent); }
.tool svg { flex: none; }
.count { font-size: var(--text-xs); font-weight: 600; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); text-align: center; line-height: 16px; }
.bell { position: relative; } .bell-count { position: absolute; top: 0; right: 0; min-width: 15px; padding: 0 3px; border-radius: 999px; background: var(--negative); color: #fff; font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; }
details { position: relative; }
summary { list-style: none; }
summary::-webkit-details-marker { display: none; }
.panel { position: fixed; right: var(--space-3); top: 52px; z-index: 5; width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 64px); overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 6px 24px rgb(0 0 0 / 0.14); padding: var(--space-1); }
.panel p { margin: 0; color: var(--text-2); }
.panel h3 { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-2); font-weight: 600; }
.hist .panel { width: min(460px, calc(100vw - 24px)); }
.hist .row { display: grid; grid-template-columns: auto 1fr auto; gap: var(--space-1) var(--space-3); align-items: baseline; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); }
.hist .row:hover { background: var(--surface-2); }
.hist .row.current { background: var(--accent-soft); }
.hist .row .v { font-weight: 600; color: var(--text); font-variant-numeric: tabular-nums; }
.hist .row .who { color: var(--text-2); overflow-wrap: anywhere; }
.hist-icon { display: none; }
.hist .row .diff { color: var(--accent); font-size: var(--text-xs); }
.hist .compare { display: block; border-top: 1px solid var(--border); margin-top: var(--space-1); padding: var(--space-2) var(--space-3); color: var(--accent); }
.more-panel > details { border-bottom: 1px solid var(--border); }
.more-panel > details > summary { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); cursor: pointer; color: var(--text); font-weight: 500; border-radius: var(--radius-sm); }
.more-panel > details > summary:hover { background: var(--surface-2); }
.more-panel > details > summary::after { content: "▸"; margin-left: auto; color: var(--text-3); }
.more-panel > details[open] > summary::after { content: "▾"; }
.more-panel .sect { display: grid; gap: var(--space-2); padding: var(--space-1) var(--space-3) var(--space-3); }
.more-panel .item { display: flex; width: 100%; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); color: var(--text); background: none; border: 0; font: inherit; text-align: left; cursor: pointer; }
.more-panel .item:hover { background: var(--surface-2); }
.sect form { margin: 0; }
.sect .row { display: flex; gap: var(--space-2); align-items: center; }
.sect input[type=text], .sect select { flex: 1; min-width: 0; font: inherit; padding: 5px var(--space-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
.sect button { font: inherit; padding: 4px var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; white-space: nowrap; }
.sect button:hover { background: var(--surface-2); }
.sect button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.sect button.danger { color: var(--negative); }
.sect .choice { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); color: var(--text-2); }
.sect .choice label { display: inline-flex; gap: var(--space-1); align-items: center; cursor: pointer; }
.sect .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.sect .modes { display: grid; gap: var(--space-2); }
.sect .mode { display: flex; gap: var(--space-2); align-items: flex-start; cursor: pointer; }
.sect .mode input[type=radio] { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent); }
.sect .people { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.sect .people li { display: flex; align-items: center; gap: var(--space-2); }
.sect .people li > span:first-child { flex: 1; color: var(--text); }
.sect .people button { border: 0; background: none; padding: 0 4px; color: var(--text-2); }
.sect .chips-edit { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1); }
.sect .chips-edit li { display: flex; align-items: center; gap: 2px; }
.sect .chips-edit button { border: 0; background: none; color: var(--text-2); padding: 0 2px; }
.sect .suggest { display: flex; flex-wrap: wrap; gap: var(--space-1); align-items: center; color: var(--text-2); font-size: var(--text-xs); }
.sect .suggest button { border: 0; padding: 0 var(--space-2); border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-size: var(--text-xs); line-height: 1.6; }
.sect .suggest button:hover { background: var(--accent-soft); color: var(--accent); }
.sect .link { display: flex; gap: var(--space-2); }
.muted { color: var(--text-2); }
.small { font-size: var(--text-xs); }
.old-strip { flex: none; padding: var(--space-2) var(--space-4); background: color-mix(in srgb, var(--warning) 12%, var(--surface)); color: var(--warning); border-bottom: 1px solid var(--border); }
.old-strip a { color: var(--accent); text-decoration: underline; }
iframe { flex: 1; width: 100%; min-width: 0; border: 0; background: #fff; }
.main { flex: 1; display: flex; min-height: 0; position: relative; }
.frame-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.side { display: none; width: 280px; flex-shrink: 0; overflow: auto; border-right: 1px solid var(--border); background: var(--surface); padding: var(--space-3) var(--space-2) var(--space-6); }
body.with-side .side { display: block; }
.side .site { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-2); }
.side .site > a { color: var(--text-2); font-size: var(--text-xs); }
.side .site > a:first-child { font-weight: 650; color: var(--text); font-size: var(--text-sm); }
.side .site > a:hover { text-decoration: underline; }
.side form { margin: var(--space-2) var(--space-1) var(--space-3); }
.side input[type=search] { width: 100%; box-sizing: border-box; font: inherit; padding: 5px var(--space-3); border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--text); }
.side .proj { display: flex; align-items: center; gap: var(--space-1); padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); }
.side .proj.current { background: var(--accent-soft); }
.side .proj > a { font-weight: 650; font-size: var(--text-md); color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .proj.current > a { color: var(--accent); }
.side .proj > a:hover { text-decoration: underline; }
.side .switch > summary { cursor: pointer; color: var(--text-2); padding: 2px 6px; border-radius: var(--radius-sm); }
.side .switch > summary:hover { background: var(--surface-2); color: var(--text); }
.side .switch .panel { position: absolute; left: auto; right: 0; top: calc(100% + 4px); width: 240px; }
.side .switch .panel a { display: block; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); color: var(--text); }
.side .switch .panel a:hover { background: var(--surface-2); }
.side .switch .panel a.current { color: var(--accent); font-weight: 600; }
.side .links { display: flex; flex-wrap: wrap; gap: 0 var(--space-3); padding: 2px var(--space-2) var(--space-3); font-size: var(--text-xs); }
.side .links a { color: var(--text-2); }
.side .links a:hover { color: var(--text); text-decoration: underline; }
.side .tree .node a { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.mention-list { list-style: none; margin: 0; padding: var(--space-1); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: 0 4px 12px rgb(0 0 0 / 0.15); min-width: 180px; }
.mention-list li { padding: 4px var(--space-2); border-radius: var(--radius-sm); cursor: pointer; }
.mention-list li.on, .mention-list li:hover { background: var(--accent-soft); color: var(--accent); }
.c-body .mention { color: var(--accent); font-weight: 600; }
.comments { display: none; width: 340px; flex-shrink: 0; overflow: auto; border-left: 1px solid var(--border); background: var(--surface); padding: var(--space-3); }
body.with-comments .comments { display: block; }
.comments h2 { font-size: var(--text-sm); margin: 0 0 var(--space-1); }
.comments .hint { margin: 0 0 var(--space-3); color: var(--text-2); font-size: var(--text-xs); }
.comments textarea { width: 100%; box-sizing: border-box; min-height: 64px; font: inherit; padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); resize: vertical; }
.comments button { font: inherit; padding: 3px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; }
.comments button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
.comments button.quiet { border-color: transparent; background: none; color: var(--text-2); padding: 3px var(--space-1); }
.comments button.quiet:hover { color: var(--negative); }
.comments blockquote { margin: 0 0 var(--space-2); padding: 2px var(--space-2); border-left: 3px solid var(--warning); color: var(--text-2); cursor: pointer; white-space: pre-wrap; }
.c-new { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.c-new button { justify-self: end; }
.thread { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); margin: 0 0 var(--space-3); background: var(--bg); }
.thread.flash { outline: 2px solid var(--accent); }
.thread.settled { opacity: 0.75; }
.c-head { color: var(--text-2); font-size: var(--text-xs); display: flex; gap: var(--space-1); align-items: baseline; flex-wrap: wrap; }
.c-head strong { color: var(--text); }
.c-body { white-space: pre-wrap; word-break: break-word; margin: 2px 0 var(--space-2); }
.reply { border-top: 1px solid var(--border); padding-top: var(--space-2); }
.c-actions { display: flex; gap: var(--space-2); align-items: flex-start; flex-wrap: wrap; }
.c-actions details { flex: 1; } .c-actions summary { cursor: pointer; color: var(--accent); }
.c-actions details form { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
.c-actions form { margin: 0; }
.settled-list summary { cursor: pointer; color: var(--text-2); margin-bottom: var(--space-2); }
.sel-btn { position: absolute; right: 16px; top: 12px; z-index: 2; font: inherit; font-weight: 600; padding: 6px var(--space-3); border: 1px solid var(--accent); border-radius: 999px; background: var(--accent); color: var(--accent-text); box-shadow: 0 2px 10px rgb(0 0 0 / 0.2); cursor: pointer; }
body.with-comments .sel-btn { right: 356px; }
.phone-only { display: none; }
@media (max-width: 1100px) { .meta { display: none; } }
@media (max-width: 760px) { .chips, .bar .badge:not(.keep) { display: none; } }
@media (max-width: 640px) {
  .bar { padding: 0 var(--space-2); gap: 2px; }
  .label, .crumbs a, .crumbs .sep, .watch-bar, .divider { display: none; }
  .tool { padding: 5px 7px; }
  .phone-only { display: block; }
  .hist-icon { display: inline-flex; }
  body.with-side .side { position: fixed; top: 48px; bottom: 0; left: 0; z-index: 4; width: min(300px, 85vw); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
  body.with-comments .comments { position: fixed; top: 48px; bottom: 0; right: 0; z-index: 4; width: min(340px, 92vw); box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); }
  body.with-comments .sel-btn { right: 16px; }
  .panel { left: 8px; right: 8px; width: auto; }
}
`;

/** Who saved a version, in words: the person, or whose agent on which computer. */
function authorLabel(a: Pick<VersionAuthor, "device_id" | "device_name" | "owner_name"> | undefined): string {
  const t = WHO;
  if (!a) return t.someone;
  if (a.device_id?.startsWith(BROWSER_DEVICE_PREFIX)) return a.owner_name ?? (a.device_name ?? t.someone).replace(/ \(browser\)$/, "");
  if (a.device_name && a.owner_name) return t.agent(a.owner_name, a.device_name);
  return a.device_name ?? t.someone;
}

/** Who did something in a feed or a comment: the person, or whose agent. */
function actorLabel(r: { actor_name: string; actor_device: string | null; agent_of: string | null }): string {
  return r.actor_device && r.agent_of ? WHO.agent(r.agent_of, r.actor_name) : r.actor_name;
}

const SPEECH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
const PENCIL = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

async function viewerPage(c: Context<AppEnv>, id: string, requested: number | undefined) {
  const artifact = await getArtifact(c.env.DB, id);
  const viewer = c.get("viewer");
  const t = VIEWER;
  // A page in a space the viewer is not let into is answered like a page that does not exist.
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.notFound();
  const versionNumber = requested ?? artifact.current_version;
  const version = await getVersion(c.env.DB, id, versionNumber);
  if (!version) return c.notFound();
  const access = await accessFor(c.env.DB, viewer);
  const tree = (await listProjectPages(c.env.DB, artifact.project)).filter((r) => !access.hiddenPages.has(r.id));
  const trail = ancestorsOf(tree, id);
  const editor = viewer.role !== "root" && viewer.sessionKind === "full" && (await canEditPage(c.env.DB, viewer, artifact));
  const visible = (rows: LinkedPage[]) => rows.filter((r) => access.sees(r));
  const [from, to, comments, authors, homes, stats] = await Promise.all([
    linkedFrom(c.env.DB, id).then(visible),
    linksTo(c.env.DB, id).then(visible),
    listComments(c.env.DB, id),
    versionAuthors(c.env.DB, id),
    homePages(c.env.DB, access.hiddenPages),
    listProjectStats(c.env.DB),
  ]);
  const threads = threadsOf(comments);
  const [watched, projectPeople, labelMap, restrictions, audience, space] = await Promise.all([
    watching(c.env.DB, viewer.userId, [pageTarget(id), ...(artifact.project ? [projectTarget(artifact.project)] : [])]),
    peopleWhoCanSee(c.env.DB, artifact.project),
    labelsOf(c.env.DB, [id]),
    restrictionsOn(c.env.DB, id),
    pageAudience(c.env.DB, id),
    artifact.project ? getSpace(c.env.DB, artifact.project) : Promise.resolve(null),
  ]);
  const labels = labelMap.get(id) ?? [];
  // Only the people who may see this page can be named in its comments.
  const people = projectPeople.filter(audience).map((p) => ({ id: p.id, name: p.name }));
  const full = viewer.sessionKind === "full";
  const owner = viewer.role === "root";
  const canEdit = (owner || editor) && full;
  const mayRestrict = canEdit;
  const accessRows = mayRestrict ? await listAccess(c.env.DB, id) : [];
  const openThreads = threads.filter((x) => !x.first.resolved_at);
  const settles = (x: Thread) => full && (owner || editor || x.first.author_user === viewer.userId);
  const deletes = (x: CommentRow) => full && (owner || x.author_user === viewer.userId);
  const projects = visibleProjects(stats, access)
    .flatMap((p) => (p.project ? [p.project] : []))
    .sort((a, b) => a.localeCompare(b));
  const templates = canEdit ? (await markdownPages(c.env.DB, artifact.project, TEMPLATE_LABEL)).filter((r) => !access.hiddenPages.has(r.id)) : [];
  const labelChoices = canEdit ? (await labelCounts(c.env.DB, access, artifact.project)).map((l) => l.label).filter((l) => !labels.includes(l) && l !== HOME_LABEL) : [];
  const shareUrl = shareActive(artifact)
    ? `${c.get("config").origin}${sharePath(id, await shareKey(c.env.CONTENT_TOKEN_SECRET, id, artifact.share_nonce))}`
    : undefined;
  // The frame keeps this URL while the page is open: the script below renews its lease.
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, versionNumber, undefined, viewer.userId, true);
  const src = frameSrc(token, version.entry);
  const openHref = `/a/${id}/open?v=${versionNumber}`;
  const nonce = c.get("nonce");
  const isLatest = versionNumber === artifact.current_version;
  const markdown = version.entry.endsWith(".md");
  const home = artifact.project ? homes.get(artifact.project) : undefined;
  // Reading a page answers the notifications about its changes; opening its comments, those too.
  const showComments = c.req.query("comments") === "1";
  const unread = Math.max(0, viewer.unread - (await markSeen(c.env.DB, viewer.userId, id, { comments: showComments })));
  const pageWatched = watched.has(pageTarget(id));
  const projectWatched = artifact.project ? watched.has(projectTarget(artifact.project)) : false;
  const shown = authors.find((a) => a.version === versionNumber);
  const author = authorLabel(shown);
  // The tree beside the page leaves out the project's front page: the project's name stands for it.
  const sideRows = home ? tree.filter((r) => r.id !== home.id) : tree;
  const crumbs = trail.filter((r) => r.id !== home?.id);
  const folded = crumbs.length > 2 ? crumbs.slice(-2) : crumbs;
  const front = artifact.project ? (home ? `/a/${home.id}` : projectHref(artifact.project)) : projectHref(null);
  const open = (q: string) => c.req.query(q) === "1";
  const moreOpen = open("labels") || open("access") || open("share") || open("move") || open("new");
  const restricted = restrictions.length > 0;
  const bypass = restricted || space?.access === "members";
  return c.html(
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{artifact.title}</title>
        <style>{raw(TOKENS + VIEWER_STYLES + TREE_STYLES)}</style>
        <script src="/assets/ui.js" defer></script>
      </head>
      <body>
        <script nonce={nonce}>
          {raw(`(() => { let on = null; try { on = localStorage.getItem("artifact.side"); } catch {}
  if (on === null ? window.innerWidth >= 900 : on === "1") document.body.classList.add("with-side"); })();`)}
        </script>
        <div class="bar">
          <button type="button" id="side-toggle" class="tool icon" aria-controls="side" aria-label={t.sideToggle} title={t.sideToggle}>
            ☰
          </button>
          <nav class="crumbs" aria-label={t.whereThisIs}>
            {artifact.project && artifact.id !== home?.id && (
              <>
                <a href={front} title={artifact.project}>
                  {artifact.project}
                </a>
                <span class="sep" aria-hidden="true">
                  ›
                </span>
              </>
            )}
            {crumbs.length > folded.length && (
              <>
                <a href={`/a/${crumbs[crumbs.length - folded.length - 1]!.id}`} title={crumbs.slice(0, crumbs.length - folded.length).map((r) => r.title).join(" › ")}>
                  …
                </a>
                <span class="sep" aria-hidden="true">
                  ›
                </span>
              </>
            )}
            {folded.map((r) => (
              <>
                <a href={`/a/${r.id}`} title={r.title}>
                  {r.title}
                </a>
                <span class="sep" aria-hidden="true">
                  ›
                </span>
              </>
            ))}
            <span class="title" title={artifact.title}>
              {artifact.title}
            </span>
          </nav>
          {isLatest && <span class="meta">{versionNumber === 1 ? t.created(<Time iso={version.created_at} />, author) : t.updated(<Time iso={version.created_at} />, author)}</span>}
          <a id="newer" class="badge public keep" href={`/a/${id}`} hidden title={t.newerTitle} />
          <span id="editing" class="badge public keep" hidden />
          {version.allow_connect.length > 0 && (
            <span class="badge" title={t.externalTitle(version.allow_connect.join(", "))}>
              {t.external}
            </span>
          )}
          {shareUrl && (
            <span class="badge public" title={t.publicTitle}>
              {t.publicBadge}
            </span>
          )}
          {restricted && !mayRestrict && (
            <span class="badge public" title={restrictions.some((r) => r.restriction === "view") ? t.restrictedView : t.restrictedEdit}>
              {t.restricted}
            </span>
          )}
          {labels.length > 0 && (
            <span class="chips">
              <LabelChips labels={labels} project={artifact.project} />
            </span>
          )}
          <span class="spacer" />
          <div class="tools">
            {isLatest && canEdit && markdown && (
              <a href={`/a/${id}/edit`} class="tool primary" title={t.editTitle}>
                {PENCIL} <span class="label">{t.edit}</span>
              </a>
            )}
            <button type="button" id="comments-toggle" class="tool" aria-controls="comments" title={t.comments}>
              {SPEECH} <span class="label">{t.comments}</span>
              {openThreads.length > 0 && (
                <span class="count" title={t.openThreads(openThreads.length)}>
                  {openThreads.length}
                </span>
              )}
            </button>
            {full && <WatchControl id={id} project={artifact.project} page={pageWatched} projectWide={projectWatched} csrf={viewer.csrf} class="watch-bar" />}
            <details class="hist" data-menu>
              <summary class="tool" title={t.history}>
                <span class="label">{t.history}</span>
                <span class="hist-icon" aria-hidden="true">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                </span>{" "}
                ▾
              </summary>
              <div class="panel">
                {authors.map((v) => (
                  <div class={`row${v.version === versionNumber ? " current" : ""}`}>
                    <a class="v" href={v.version === artifact.current_version ? `/a/${id}` : `/a/${id}/v/${v.version}`}>
                      v{v.version}
                      {v.version === artifact.current_version && ` · ${t.latest}`}
                    </a>
                    <span class="who">
                      {authorLabel(v)} · <Time iso={v.created_at} />
                    </span>
                    {v.version > 1 ? (
                      <a class="diff" href={`/a/${id}/diff?from=${v.version - 1}&to=${v.version}`}>
                        {t.changes}
                      </a>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
                {authors.length > 1 && (
                  <a href={`/a/${id}/diff?from=${authors[1]!.version}&to=${authors[0]!.version}`} class="compare">
                    {t.compare}
                  </a>
                )}
              </div>
            </details>
            <details class="more" data-menu open={moreOpen}>
              <summary class="tool icon" aria-label={t.more} title={t.more}>
                ⋯
              </summary>
              <div class="panel more-panel">
                {full && (
                  <div class="phone-only">
                    <WatchControl id={id} project={artifact.project} page={pageWatched} projectWide={projectWatched} csrf={viewer.csrf} class="item" />
                  </div>
                )}
                {isLatest && canEdit && (
                  <details data-section open={open("new")}>
                    <summary>{t.newPage}</summary>
                    <div class="sect">
                      <NewPageForm id={id} parent={artifact.parent} project={artifact.project} isHome={artifact.id === home?.id} templates={templates} csrf={viewer.csrf} />
                    </div>
                  </details>
                )}
                {canEdit && (
                  <details data-section open={open("labels")}>
                    <summary>{t.labels}</summary>
                    <div class="sect">
                      <LabelSection id={id} labels={labels} choices={labelChoices} csrf={viewer.csrf} />
                    </div>
                  </details>
                )}
                {canEdit && (
                  <details data-section open={open("move")}>
                    <summary>{t.move}</summary>
                    <div class="sect">
                      <MoveSection id={id} project={artifact.project} projects={owner ? projects : undefined} csrf={viewer.csrf} tree={tree} parent={artifact.parent} />
                    </div>
                  </details>
                )}
                {mayRestrict && (
                  <details data-section open={open("access")}>
                    <summary>
                      {t.who}
                      {restricted && <span class="badge public">{t.restricted}</span>}
                    </summary>
                    <div class="sect">
                      <AccessSection
                        id={id}
                        csrf={viewer.csrf}
                        restrictions={restrictions}
                        rows={accessRows}
                        people={projectPeople.filter((p) => p.role !== "root")}
                        me={viewer.userId}
                       
                      />
                    </div>
                  </details>
                )}
                {owner && full && (
                  <details data-section open={open("share")}>
                    <summary>
                      {t.publicLink}
                      {shareUrl && <span class="badge public">{t.publicBadge}</span>}
                    </summary>
                    <div class="sect">
                      <ShareSection id={id} artifact={artifact} shareUrl={shareUrl} bypass={bypass} csrf={viewer.csrf} />
                    </div>
                  </details>
                )}
                {(from.length > 0 || to.length > 0) && (
                  <details data-section>
                    <summary>{t.linked(from.length + to.length)}</summary>
                    <div class="sect">
                      <LinksSection from={from} to={to} />
                    </div>
                  </details>
                )}
                {isLatest && canEdit && !markdown && (
                  <a href={`/a/${id}/edit`} class="item" title={t.editSourceTitle}>
                    {t.editSource}
                  </a>
                )}
                <button type="button" class="item" data-copy={`/a/${id}`} data-copied={t.copied} title={t.copyTitle}>
                  {t.copyLink}
                </button>
                <a id="open" href={openHref} target="_blank" rel="noopener noreferrer" class="item" title={t.newTabTitle}>
                  {t.newTab} ↗
                </a>
              </div>
            </details>
            <span class="divider" aria-hidden="true" />
            <Bell unread={unread} class="tool icon bell" />
          </div>
        </div>
        <div class="main">
          <nav id="side" class="side" aria-label={t.sideToggle}>
            <div class="site">
              <a href="/">{t.site}</a>
              <a href="/activity" class="muted small">
                {t.activity}
              </a>
            </div>
            <form method="get" action="/search" role="search">
              <input type="search" name="q" placeholder={t.search} aria-label={t.search} />
            </form>
            <div class={`proj${artifact.id === home?.id ? " current" : ""}`}>
              <a href={front} title={artifact.project ? t.frontPage(artifact.project) : t.noProject}>
                {artifact.project ?? t.noProject}
              </a>
              {projects.length > 0 && (
                <details class="switch" data-menu>
                  <summary title={t.switchProject} aria-label={t.switchProject}>
                    ▾
                  </summary>
                  <div class="panel">
                    {projects.map((p) => (
                      <a href={homes.get(p) ? `/a/${homes.get(p)!.id}` : projectHref(p)} class={p === artifact.project ? "current" : undefined}>
                        {p}
                      </a>
                    ))}
                    {visibleProjects(stats, access).some((p) => p.project === null) && <a href={projectHref(null)}>{t.noProject}</a>}
                  </div>
                </details>
              )}
            </div>
            <div class="links">
              <a href={projectHref(artifact.project)}>{t.allPages}</a>
              {artifact.project && <a href={`/activity?project=${encodeURIComponent(artifact.project)}`}>{t.activity}</a>}
            </div>
            <PageTree rows={sideRows} current={id} open={new Set([...trail.map((r) => r.id), id])} project={artifact.project} />
          </nav>
          <div class="frame-col">
            {!isLatest && (
              <div class="old-strip">
                {t.oldVersion(versionNumber, artifact.current_version)} · <a href={`/a/${id}`}>{t.showLatest}</a>
              </div>
            )}
            <iframe id="frame" src={src} sandbox={SANDBOX_FLAGS} title={artifact.title} />
            <script nonce={nonce}>{raw(FRAGMENT_INTO_FRAME)}</script>
          </div>
          <button type="button" id="sel-btn" class="sel-btn" hidden>
            {t.selection}
          </button>
          <CommentsPanel id={id} threads={threads} shown={versionNumber} csrf={viewer.csrf} canWrite={full} canSettle={settles} canDelete={deletes} />
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
const lease = { url: ${JSON.stringify(`/a/${id}/lease`)}, token: ${JSON.stringify(token)}, exp: ${exp} };
const csrf = ${jsonInScript(viewer.csrf)};
// Someone saving or editing this page meanwhile: say so, and offer the newer version.
{
  const shown = ${versionNumber}, latest = ${JSON.stringify(isLatest)};
  const NEWER = ${jsonInScript(t.newer("{n}", "{by}"))}, EDITING = ${jsonInScript(t.editing("{names}"))};
  const newer = document.getElementById("newer"), editors = document.getElementById("editing");
  const poll = async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(${JSON.stringify(`/a/${id}/state`)}, { credentials: "same-origin" });
      if (!res.ok) return;
      const s = await res.json();
      if (latest && s.version > shown) { newer.textContent = NEWER.replace("{n}", s.version).replace("{by}", s.by); newer.hidden = false; }
      editors.textContent = s.editing.length ? EDITING.replace("{names}", s.editing.join(", ")) : "";
      editors.hidden = !s.editing.length;
    } catch {}
  };
  setInterval(poll, 30000);
  document.addEventListener("visibilitychange", poll);
  poll();
}
// Comments beside the page; a passage selected in the page can be commented on, and commented ones are marked.
const frame = document.getElementById("frame");
let seen = ${JSON.stringify(showComments)};
const commentsOn = (on) => {
  document.body.classList.toggle("with-comments", on);
  document.getElementById("comments-toggle").setAttribute("aria-expanded", String(on));
  // Opening the comments answers the notifications about them.
  if (on && !seen) {
    seen = true;
    fetch(${JSON.stringify(`/a/${id}/seen`)}, { method: "POST", credentials: "same-origin", headers: { "x-csrf": csrf } })
      .then((r) => r.ok ? r.json() : null).then((r) => {
        const n = document.querySelector(".bell-count");
        if (r && n && r.unread >= 0) { if (r.unread === 0) n.remove(); else n.textContent = r.unread > 99 ? "99+" : String(r.unread); }
      }).catch(() => {});
  }
};
document.getElementById("comments-toggle").addEventListener("click", () => commentsOn(!document.body.classList.contains("with-comments")));
if (${JSON.stringify(showComments)}) commentsOn(true);
const quotes = ${jsonInScript(openThreads.filter((x) => x.first.quote).map((x) => ({ id: x.first.id, text: x.first.quote })))};
const selBtn = document.getElementById("sel-btn");
let selected = "";
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === "artifact:ready") frame.contentWindow.postMessage({ type: "artifact:highlight", quotes }, "*");
  if (d.type === "artifact:selection" && typeof d.text === "string") { selected = d.text.slice(0, 500); selBtn.hidden = !selected || !document.getElementById("c-body"); }
  if (d.type === "artifact:comment" && typeof d.id === "string") {
    commentsOn(true);
    const el = document.getElementById("c-" + d.id.replace(/[^0-9a-z]/g, ""));
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1500); }
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
// The page's #fragment and the address bar's go together (see NAV_JS), and "Open" and the newer
// version open the page at the same place.
const placeLinks = (hash) => {
  document.getElementById("open").href = ${JSON.stringify(openHref)} + hash;
  document.getElementById("newer").href = ${JSON.stringify(`/a/${id}`)} + hash;
};
placeLinks(location.hash);
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type !== "artifact:hash" || typeof d.hash !== "string" || d.hash.length > 2000) return;
  const url = new URL(location.href);
  url.hash = d.hash;
  if (url.href !== location.href) history.replaceState(history.state, "", url);
  placeLinks(url.hash);
});
window.addEventListener("hashchange", () => {
  frame.contentWindow.postMessage({ type: "artifact:hash", hash: location.hash }, "*");
  placeLinks(location.hash);
});
// The frame's URL runs out ten minutes after it was made unless its lease is renewed: renew it
// while this page is open, so the page in the frame keeps working and is never reloaded.
async function refresh() {
  if (Date.now() / 1000 < lease.exp - 120) return;
  try {
    const res = await fetch(lease.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf": ${JSON.stringify(viewer.csrf)} },
      body: JSON.stringify({ token: lease.token }),
    });
    if (res.ok) lease.exp = (await res.json()).exp;
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);
const copy = document.getElementById("share-copy");
if (copy) copy.addEventListener("click", async () => {
  const input = document.getElementById("share-url");
  const label = copy.textContent;
  try { await navigator.clipboard.writeText(input.value); copy.textContent = ${jsonInScript(t.copied)}; }
  catch { input.select(); }
  setTimeout(() => { copy.textContent = label; }, 1500);
});`)}
        </script>
      </body>
    </html>,
  );
}

/** Watching a page: a toggle, or a note that the whole project is watched. */
function WatchControl(props: { id: string; project: string | null; page: boolean; projectWide: boolean; csrf: string; class: string }) {
  const t = VIEWER;
  if (props.projectWide && !props.page && props.project) {
    return (
      <a class={`tool on ${props.class}`} href={projectHref(props.project)} title={t.watchingProjectTitle(props.project)}>
        {t.watchingProject(props.project)}
      </a>
    );
  }
  return (
    <form method="post" action="/watch" style="margin:0" class={props.class === "item" ? undefined : props.class}>
      <CsrfField token={props.csrf} />
      <input type="hidden" name="page" value={props.id} />
      <input type="hidden" name="on" value={props.page ? "0" : "1"} />
      <button type="submit" class={`${props.class === "item" ? "item" : "tool"}${props.page ? " on" : ""}`} title={props.page ? t.stopTitle : t.watchTitle}>
        {props.page ? `✓ ${t.watching}` : t.watch}
      </button>
    </form>
  );
}

/** Writing a new page under this one, or beside it. */
function NewPageForm(props: { id: string; parent: string | null; project: string | null; isHome: boolean; templates: MarkdownPage[]; csrf: string }) {
  const t = VIEWER;
  return (
    <form method="post" action="/new" class="sect" style="padding:0">
      <CsrfField token={props.csrf} />
      {props.project && <input type="hidden" name="project" value={props.project} />}
      <input name="title" type="text" required maxlength={200} placeholder={t.title} aria-label={t.newTitle} />
      {!props.isHome && (
        <div class="choice">
          <label>
            <input type="radio" name="parent" value={props.id} checked /> {t.under}
          </label>
          <label>
            <input type="radio" name="parent" value={props.parent ?? "-"} /> {t.beside}
          </label>
        </div>
      )}
      {props.isHome && <input type="hidden" name="parent" value={props.id} />}
      <div class="row">
        <TemplateChoice pages={props.templates} />
        <button type="submit" class="primary">
          {t.startWriting}
        </button>
      </div>
    </form>
  );
}

function ShareSection(props: { id: string; artifact: ArtifactRow; shareUrl: string | undefined; bypass: boolean; csrf: string }) {
  const { id, artifact, shareUrl, csrf } = props;
  const t = PANELS;
  const action = (path: string, label: string, cls = "") => (
    <form method="post" action={`/a/${id}/share${path}`}>
      <CsrfField token={csrf} />
      <button type="submit" class={cls || undefined}>
        {label}
      </button>
    </form>
  );
  const days = shareUrl ? Math.ceil((Date.parse(artifact.share_expires_at!) - Date.now()) / 864e5) : 0;
  return shareUrl ? (
    <>
      <p>{t.shareOn}</p>
      {props.bypass && <p class="small" style="color:var(--warning)">{t.shareBypass}</p>}
      <div class="link">
        <input id="share-url" type="text" readonly value={shareUrl} aria-label={t.publicLinkLabel} />
        <button type="button" id="share-copy">
          {t.copy}
        </button>
      </div>
      <p>
        {t.openUntil(
          <time datetime={artifact.share_expires_at!} data-exact>
            {formatTime(artifact.share_expires_at!)}
          </time>,
          t.daysLeft(days),
        )}
      </p>
      <div class="actions">
        {action("", t.extend(SHARE_DAYS))}
        {action("/reset", t.newLink)}
        {action("/off", t.turnOff, "danger")}
      </div>
    </>
  ) : (
    <>
      <p>{t.shareOff(SHARE_DAYS)}</p>
      {props.bypass && <p class="small" style="color:var(--warning)">{t.shareBypass}</p>}
      <div class="actions">{action("", t.create, "primary")}</div>
    </>
  );
}

/** The comments beside a page: open threads first, then the settled ones folded. */
function CommentsPanel(props: { id: string; threads: Thread[]; shown: number; csrf: string; canWrite: boolean; canSettle: (t: Thread) => boolean; canDelete: (c: CommentRow) => boolean }) {
  const { id, threads, csrf } = props;
  const t = COMMENTS;
  const open = threads.filter((x) => !x.first.resolved_at), settled = threads.filter((x) => x.first.resolved_at);
  const one = (c: CommentRow, reply: boolean) => (
    <div class={reply ? "reply" : undefined}>
      <div class="c-head">
        <strong>{c.author_device && c.agent_of ? WHO.agent(c.agent_of, c.author_name) : c.author_name}</strong> · <Time iso={c.created_at} />
        {c.version !== props.shown && <> · {t.onVersion(c.version)}</>}
      </div>
      <div class="c-body">{c.body}</div>
    </div>
  );
  const remove = (c: CommentRow, reply: boolean) =>
    props.canDelete(c) && (
      <form method="post" action={`/a/${id}/comments/${c.id}/delete`} data-confirm={reply ? t.deleteReply : t.deleteThread}>
        <CsrfField token={csrf} />
        <button type="submit" class="quiet">
          {t.delete}
        </button>
      </form>
    );
  const thread = (x: Thread) => (
    <article class={`thread${x.first.resolved_at ? " settled" : ""}`} id={`c-${x.first.id}`}>
      {x.first.quote && (
        <blockquote data-focus={x.first.id} title={t.showPassage}>
          {x.first.quote}
        </blockquote>
      )}
      {one(x.first, false)}
      {x.replies.map((r) => (
        <>
          {one(r, true)}
          {remove(r, true)}
        </>
      ))}
      <div class="c-actions">
        {props.canWrite && (
          <details>
            <summary>{t.reply}</summary>
            <form method="post" action={`/a/${id}/comments`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="reply_to" value={x.first.id} />
              <input type="hidden" name="mentions" value="" />
              <textarea name="body" required maxlength={4000} aria-label={t.reply} />
              <button type="submit">{t.sendReply}</button>
            </form>
          </details>
        )}
        {props.canSettle(x) && (
          <form method="post" action={`/a/${id}/comments/${x.first.id}/resolve`} class="inline">
            <CsrfField token={csrf} />
            <input type="hidden" name="resolved" value={x.first.resolved_at ? "0" : "1"} />
            <button type="submit">{x.first.resolved_at ? t.reopen : t.resolve}</button>
          </form>
        )}
        {remove(x.first, false)}
      </div>
    </article>
  );
  return (
    <aside id="comments" class="comments" aria-label={t.heading}>
      <h2>{t.heading}</h2>
      {props.canWrite && <p class="hint">{t.hint}</p>}
      {props.canWrite && (
        <form method="post" action={`/a/${id}/comments`} class="c-new">
          <CsrfField token={csrf} />
          <input type="hidden" name="quote" id="c-quote" value="" />
          <input type="hidden" name="mentions" value="" />
          <blockquote id="c-quote-show" hidden />
          <textarea name="body" id="c-body" required maxlength={4000} placeholder={t.placeholder} aria-label={t.newComment} />
          <button type="submit" class="primary">
            {t.submit}
          </button>
        </form>
      )}
      {open.length === 0 && settled.length === 0 && <p class="muted">{t.none}</p>}
      {open.map(thread)}
      {settled.length > 0 && (
        <details class="settled-list">
          <summary>{t.resolved(settled.length)}</summary>
          {settled.map(thread)}
        </details>
      )}
    </aside>
  );
}

/** The pages that link to this one and the pages it links to (only those the viewer may see). */
function LinksSection(props: { from: LinkedPage[]; to: LinkedPage[] }) {
  const t = VIEWER;
  const list = (rows: LinkedPage[]) =>
    rows.map((r) => (
      <a href={`/a/${r.id}`} class="item" style="padding:var(--space-1) 0">
        {r.title}
        {r.project && <span class="muted small">{r.project}</span>}
      </a>
    ));
  return (
    <>
      {props.from.length > 0 && (
        <>
          <h3>{t.linkedFrom}</h3>
          {list(props.from)}
        </>
      )}
      {props.to.length > 0 && (
        <>
          <h3>{t.linksTo}</h3>
          {list(props.to)}
        </>
      )}
    </>
  );
}

/** The pages a page can go under: everything in its project but itself and the pages below it, indented by depth. */
function parentChoices(tree: TreeRow[], id: string): { id: string; label: string }[] {
  const below = subtreeOf(tree, id), out: { id: string; label: string }[] = [];
  const walk = (rows: TreeRow[], depth: number) => {
    for (const r of rows) {
      if (below.has(r.id)) continue;
      out.push({ id: r.id, label: `${"   ".repeat(depth)}${r.title}` });
      walk(tree.filter((x) => x.parent === r.id), depth + 1);
    }
  };
  const ids = new Set(tree.map((r) => r.id));
  walk(tree.filter((r) => !r.parent || !ids.has(r.parent)), 0);
  return out;
}

/** Who may see and change a page, beyond what its project allows. */
function AccessSection(props: {
  id: string;
  csrf: string;
  restrictions: PathRestriction[];
  rows: { user_id: string; name: string; can: string }[];
  people: { id: string; name: string }[];
  me: string;
}) {
  const { id, csrf, rows } = props;
  const t = PANELS;
  const own = props.restrictions.find((r) => r.own)?.restriction ?? null;
  const above = props.restrictions.filter((r) => !r.own);
  const modes = [
    { value: "", label: t.modeOpen, note: t.modeOpenNote },
    { value: "edit", label: t.modeEdit, note: t.modeEditNote },
    { value: "view", label: t.modeView, note: t.modeViewNote },
  ];
  const candidates = props.people.filter((p) => !rows.some((r) => r.user_id === p.id));
  return (
    <>
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
        <div>
          <button type="submit" class="primary">
            {t.save}
          </button>
        </div>
      </form>
      {own && (
        <>
          <h3>{t.people}</h3>
          <ul class="people">
            {rows.map((r) => (
              <li>
                <span>{r.name}</span>
                <span class="muted small">{r.can === "edit" ? t.canEdit : t.canView}</span>
                {r.user_id !== props.me && (
                  <form method="post" action={`/a/${id}/access/remove`}>
                    <CsrfField token={csrf} />
                    <input type="hidden" name="user" value={r.user_id} />
                    <button type="submit" title={t.takeOff(r.name)} aria-label={t.takeOff(r.name)}>
                      ×
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {candidates.length > 0 && (
            <form method="post" action={`/a/${id}/access/people`} class="row">
              <CsrfField token={csrf} />
              <select name="user" aria-label={t.person}>
                {candidates.map((p) => (
                  <option value={p.id}>{p.name}</option>
                ))}
              </select>
              <select name="can" aria-label={t.whatTheyMay}>
                {own === "view" && <option value="view">{t.canView}</option>}
                <option value="edit">{t.canEdit}</option>
              </select>
              <button type="submit">{t.add}</button>
            </form>
          )}
          <p class="muted small">{t.ownerAlways}</p>
        </>
      )}
      {above.length > 0 && (
        <p class="muted small">
          {t.above}{" "}
          {above.map((r, k) => (
            <>
              {k > 0 && ", "}
              <a href={`/a/${r.id}`} style="color:var(--accent)">
                {r.title}
              </a>{" "}
              ({r.restriction === "view" ? t.aboveView : t.aboveEdit})
            </>
          ))}
        </p>
      )}
    </>
  );
}

/** A page's labels, to add and remove; the labels used elsewhere are one click away. */
function LabelSection(props: { id: string; labels: string[]; choices: string[]; csrf: string }) {
  const { id, labels, csrf } = props;
  const t = PANELS;
  return (
    <>
      {labels.length > 0 ? (
        <ul class="chips-edit">
          {labels.map((l) => (
            <li>
              <a class="chip" href={`/?label=${encodeURIComponent(l)}`}>
                {l}
              </a>
              <form method="post" action={`/a/${id}/labels/remove`}>
                <CsrfField token={csrf} />
                <input type="hidden" name="label" value={l} />
                <button type="submit" title={t.remove(l)} aria-label={t.remove(l)}>
                  ×
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p class="small">{t.labelsNone}</p>
      )}
      <form method="post" action={`/a/${id}/labels`} class="link">
        <CsrfField token={csrf} />
        <input name="add" type="text" required maxlength={200} placeholder={t.labelsPlaceholder} aria-label={t.labelsAdd} list="label-choices" />
        <datalist id="label-choices">
          {props.choices.map((l) => (
            <option value={l} />
          ))}
        </datalist>
        <button type="submit" class="primary">
          {t.add}
        </button>
      </form>
      {props.choices.length > 0 && (
        <div class="suggest">
          {t.labelsUsed}
          {props.choices.slice(0, 12).map((l) => (
            <form method="post" action={`/a/${id}/labels`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="add" value={l} />
              <button type="submit">+ {l}</button>
            </form>
          ))}
        </div>
      )}
    </>
  );
}

/** Which template a new page starts from: the project's template pages, then the built-in ones. */
function TemplateChoice(props: { pages: MarkdownPage[] }) {
  const t = PANELS;
  return (
    <select name="template" aria-label={t.template} title={t.template}>
      {BUILT_IN_TEMPLATES.map((x) => (
        <option value={x.id}>{x.name}</option>
      ))}
      {props.pages.length > 0 && (
        <optgroup label={t.projectTemplates}>
          {props.pages.map((p) => (
            <option value={`page:${p.id}`}>{p.title}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/** `projects`: the owner's choice of projects; an editor (without it) only moves pages within the project. */
function MoveSection(props: { id: string; project: string | null; projects?: string[]; csrf: string; tree: TreeRow[]; parent: string | null }) {
  const { id, project, projects, csrf, tree } = props;
  const t = PANELS;
  const siblings = siblingsOf(tree, id);
  const place = siblings.findIndex((r) => r.id === id);
  return (
    <>
      {project && (
        <>
          <h3>{t.placeIn(project)}</h3>
          <form method="post" action={`/a/${id}/parent`} class="row">
            <CsrfField token={csrf} />
            <select name="parent" aria-label={t.parent}>
              <option value="" selected={!props.parent}>
                {t.top(project)}
              </option>
              {parentChoices(tree, id).map((o) => (
                <option value={o.id} selected={o.id === props.parent}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="submit" class="primary">
              {t.putUnder}
            </button>
          </form>
          {siblings.length > 1 && (
            <div class="actions">
              {(["up", "down"] as const).map((dir) => (
                <form method="post" action={`/a/${id}/order`}>
                  <CsrfField token={csrf} />
                  <input type="hidden" name="dir" value={dir} />
                  <button type="submit" disabled={dir === "up" ? place <= 0 : place >= siblings.length - 1}>
                    {dir === "up" ? t.earlier : t.later}
                  </button>
                </form>
              ))}
            </div>
          )}
        </>
      )}
      {projects && (
        <>
          {project && <h3>{t.project}</h3>}
          <p class="small">{project ? t.inProject(project) : t.noProjectYet}</p>
          <form method="post" action={`/a/${id}/project`} class="row">
            <CsrfField token={csrf} />
            <input name="project" type="text" list="project-names" required maxlength={60} placeholder={t.project} aria-label={t.project} />
            <datalist id="project-names">
              {projects
                .filter((p) => p !== project)
                .map((p) => (
                  <option value={p} />
                ))}
            </datalist>
            <button type="submit">{t.moveTo}</button>
          </form>
          {project && (
            <form method="post" action={`/a/${id}/project`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="project" value="" />
              <button type="submit">{t.removeFrom(project)}</button>
            </form>
          )}
        </>
      )}
    </>
  );
}

pages.get("/a/:id", requireViewer(), (c) => viewerPage(c, c.req.param("id"), undefined));

pages.get("/a/:id/v/:version{[0-9]+}", requireViewer(), (c) => viewerPage(c, c.req.param("id"), Number(c.req.param("version"))));

/** A fresh content URL, without a lease: the source editor hands one to its frame before the last runs out. */
pages.get("/a/:id/token", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.json({ error: "not found" }, 404);
  const version = await getVersion(c.env.DB, id, Number(c.req.query("v") ?? artifact.current_version));
  if (!version) return c.json({ error: "not found" }, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version, undefined, c.get("viewer").userId);
  return c.json({ src: frameSrc(token, version.entry), exp });
});

/**
 * The viewer page renews the lease of its frame's URL while it is open (see CONTENT_TOKEN_SECONDS).
 * Only the person the URL was made for can, and only while they may still see the page: once
 * they may not, the URL stops within ten minutes, as a token without a lease would.
 */
pages.post("/a/:id/lease", requireViewer(), requireSameOriginJson(), async (c) => {
  const id = c.req.param("id");
  const viewer = c.get("viewer");
  const body: { token?: unknown } = await c.req.json().catch(() => ({}));
  const claims = typeof body.token === "string" ? await signedContentClaims(c.env.CONTENT_TOKEN_SECRET, body.token) : undefined;
  if (!claims?.l || claims.a !== id || claims.u !== viewer.userId || claims.s !== undefined) return c.json({ error: "That is not the lease of this page." }, 400);
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.json({ error: "not found" }, 404);
  return c.json({ exp: await renewContentLease(c.env.DB, claims.l) });
});

/**
 * "Open in a new tab": the content URL is made when the link is followed, so the link itself is
 * not a bearer URL that works for anyone. The browser keeps the link's #fragment across the redirect.
 */
pages.get("/a/:id/open", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeePage(c.env.DB, c.get("viewer"), artifact))) return c.notFound();
  const version = await getVersion(c.env.DB, id, Number(c.req.query("v") ?? artifact.current_version));
  if (!version) return c.notFound();
  const { token } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version, undefined, c.get("viewer").userId);
  return c.redirect(frameSrc(token, version.entry), 302);
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
  return storeText(c, markdown, "text/markdown; charset=utf-8");
}

async function storeText(c: Context<AppEnv>, text: string, type: string): Promise<VersionFile> {
  const bytes = utf8(text);
  const sha256 = await sha256Hex(bytes);
  if (!(await c.env.BLOBS.head(blobKey(sha256)))) await c.env.BLOBS.put(blobKey(sha256), bytes, { sha256 });
  return { sha256, size: bytes.length, type };
}

const blobText = async (c: Context<AppEnv>, sha256: string) => (await c.env.BLOBS.get(blobKey(sha256)))?.text();

const titleSchema = z.string().trim().min(1, "A page needs a title.").max(200, "A title is at most 200 characters.");

/** A new Markdown page, in a project (the owner, or its editors) and optionally under a page of it. */
pages.post("/new", requireViewer("viewer", true), requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody();
  const title = titleSchema.safeParse(typeof form["title"] === "string" ? form["title"] : "");
  if (!title.success) return c.text(title.error.issues[0]!.message, 400);
  // "-" asks for the top of the project; no parent puts the page under the project's front page.
  const top = form["parent"] === "-";
  const named = typeof form["parent"] === "string" && form["parent"] && !top ? form["parent"] : undefined;
  const chosenProject = typeof form["project"] === "string" && form["project"] ? form["project"] : null;
  if (chosenProject !== null && !projectSchema.safeParse(chosenProject).success) return c.text("That is not a project name.", 400);
  const parentId = named ?? (top ? undefined : (await homeOf(c.env.DB, chosenProject))?.id);
  let parent = parentId ? await getArtifact(c.env.DB, parentId) : undefined;
  if (parentId && !parent) return c.text("The page to put it under no longer exists.", 400);
  // The front page may be closed to this writer; then the page starts at the top instead.
  if (!named && parent && !(await canEditPage(c.env.DB, viewer, parent))) parent = undefined;
  const project = parent ? parent.project : chosenProject;
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
  if (!/\.(md|html?)$/i.test(version.entry)) return c.text("This page cannot be changed in the browser.", 400);
  return { artifact, version };
}

pages.get("/a/:id/edit", requireViewer("viewer", true), async (c) => {
  const id = c.req.param("id");
  const found = await writable(c, id);
  if (found instanceof Response) return found;
  if (!found.version.entry.endsWith(".md")) return sourceEditor(c, found.artifact, found.version);
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
  frame.contentWindow.postMessage({ type: "artifact:link", href: "/a/" + link.value, text: titles[link.value] }, "*");
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

const saveSchema = z.object({
  base_version: z.number().int().positive(),
  title: titleSchema,
  /** A Markdown page's text. */
  markdown: z.string().optional(),
  /** An HTML page's changed files, by path. */
  files: z.record(z.string(), z.string()).optional(),
  merge: z.boolean().optional(),
});

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
  if (!version.entry.endsWith(".md")) return saveSource(c, found, parsed.data);
  const { base_version, title } = parsed.data;
  if (parsed.data.markdown === undefined) return c.json({ error: "No text to save." }, 400);
  let markdown = parsed.data.markdown;
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


/** An HTML page's source, in the sandbox, with the files to choose from and a preview. */
async function sourceEditor(c: Context<AppEnv>, artifact: ArtifactRow, version: VersionRow) {
  const id = artifact.id;
  const viewer = c.get("viewer");
  const files = editableFiles(version.files, version.entry);
  const { token } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version, undefined, viewer.userId);
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
          {files.length > 1 && (
            <select id="file" aria-label="File to change">
              {files.map((f) => (
                <option value={f}>{f}</option>
              ))}
            </select>
          )}
          <button type="button" id="preview-toggle" aria-pressed="false" title="Show the page as it is being edited">
            Preview
          </button>
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
        <iframe id="editor" src={`/c/${token}/${SOURCE_PATH}`} sandbox={SANDBOX_FLAGS} title="Source" />
        <script nonce={nonce}>
          {raw(`
const frame = document.getElementById("editor"), status = document.getElementById("status"), who = document.getElementById("who");
const headers = { "content-type": "application/json", "x-csrf": ${JSON.stringify(viewer.csrf)} };
const presence = ${JSON.stringify(`/a/${id}/presence`)}, tokenUrl = ${JSON.stringify(`/a/${id}/token?v=${version.version}`)};
let base = ${version.version}, waiting = null;
const pick = document.getElementById("file");
window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === "artifact:files" && waiting) { waiting(d.files || {}); waiting = null; }
  if (d.type === "artifact:opened" && pick && typeof d.path === "string") pick.value = d.path;
});
const changed = () => new Promise((ok, fail) => {
  waiting = ok;
  frame.contentWindow.postMessage({ type: "artifact:get-files" }, "*");
  setTimeout(() => { if (waiting) { waiting = null; fail(new Error("The editor did not answer.")); } }, 5000);
});
if (pick) pick.addEventListener("change", () => frame.contentWindow.postMessage({ type: "artifact:open", path: pick.value }, "*"));
const toggle = document.getElementById("preview-toggle");
toggle.addEventListener("click", () => {
  const on = toggle.getAttribute("aria-pressed") !== "true";
  toggle.setAttribute("aria-pressed", String(on));
  frame.contentWindow.postMessage({ type: "artifact:preview", on }, "*");
});
// The editor's link to the page's files lasts ten minutes: hand it a fresh one before then.
setInterval(async () => {
  try {
    const res = await fetch(tokenUrl, { credentials: "same-origin" });
    if (!res.ok) return;
    const { src } = await res.json();
    frame.contentWindow.postMessage({ type: "artifact:root", root: new URL(src.slice(0, src.indexOf("/", 3) + 1), location.href).href }, "*");
  } catch {}
}, 8 * 60 * 1000);
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
    const body = JSON.stringify({ base_version: base, title: document.getElementById("title").value, files: await changed(), merge: true });
    const res = await fetch(location.pathname, { method: "POST", credentials: "same-origin", headers, body });
    const out = await res.json().catch(() => ({}));
    if (res.ok) { location.href = ${JSON.stringify(`/a/${id}`)}; return; }
    status.className = "status error";
    if (res.status === 409 && out.merged_files) {
      // Both changed the same lines: the merged files, with both sides marked, go into the editor.
      base = out.current_version;
      frame.contentWindow.postMessage({ type: "artifact:set-files", files: out.merged_files }, "*");
      status.textContent = (out.conflicts === 1 ? "1 part" : out.conflicts + " parts") + " changed both by you and in v" + out.current_version + " by " + out.by
        + ". Both are marked in the source: keep what should stay, delete the <<<<<<<, ======= and >>>>>>> lines, and save.";
      who.hidden = true;
      return;
    }
    status.textContent = res.status === 409
      ? "Version " + out.current_version + " was saved meanwhile by " + (out.by || "someone") + " and could not be merged. Copy your changes, reload, and make them again."
      : (out.error || "Saving failed.");
  } catch (e) { status.className = "status error"; status.textContent = e.message; }
});`)}
        </script>
      </body>
    </html>,
  );
}

/**
 * Saves the changed files of an HTML page as a new version, merged into what was saved meanwhile
 * when asked; the text and links for search come from its HTML again, as the CLI reads them.
 */
async function saveSource(c: Context<AppEnv>, found: { artifact: ArtifactRow; version: VersionRow }, data: z.infer<typeof saveSchema>) {
  const { artifact, version } = found;
  const id = artifact.id;
  const allowed = new Set(editableFiles(version.files, version.entry));
  const mine = data.files ?? {};
  for (const [path, text] of Object.entries(mine)) {
    if (!allowed.has(path)) return c.json({ error: `${path} cannot be changed here.` }, 400);
    if (utf8(text).length > MAX_SOURCE_BYTES) return c.json({ error: `${path} is over 1 MB.` }, 413);
  }
  let base = data.base_version;
  let changes = mine;
  let merged = false;
  if (base !== artifact.current_version) {
    const latest = artifact.current_version;
    const by = await savedBy(c, id, latest);
    const was = data.merge ? await getVersion(c.env.DB, id, base) : undefined;
    if (!was) return c.json({ error: "version_conflict", current_version: latest, by }, 409);
    const out: Record<string, string> = {};
    let conflicts = 0;
    for (const [path, text] of Object.entries(mine)) {
      const [before, now] = await Promise.all([was.files[path] && blobText(c, was.files[path].sha256), version.files[path] && blobText(c, version.files[path].sha256)]);
      const result = before !== undefined && now !== undefined ? merge3(before, text, now, { mine: "your text", theirs: `v${latest} by ${by}` }) : undefined;
      if (!result) return c.json({ error: "version_conflict", current_version: latest, by }, 409);
      out[path] = result.text;
      conflicts += result.conflicts;
    }
    if (conflicts > 0) return c.json({ error: "version_conflict", current_version: latest, by, merged_files: out, conflicts }, 409);
    changes = out;
    base = latest;
    merged = true;
  }
  if (data.merge && Object.values(changes).some(hasConflictMarks)) {
    return c.json({ error: "The source still has conflict marks (<<<<<<< and >>>>>>>). Keep what should stay and remove them." }, 400);
  }
  const files = { ...version.files };
  for (const [path, text] of Object.entries(changes)) files[path] = await storeText(c, text, version.files[path]!.type);
  // What the page says and links to, from its HTML files, the entry first.
  const pagesHtml = [version.entry, ...Object.keys(files).filter((p) => p !== version.entry && /\.html?$/i.test(p))];
  const htmls = await Promise.all(pagesHtml.map(async (p) => changes[p] ?? (await blobText(c, files[p]!.sha256)) ?? ""));
  const origin = c.get("config").origin;
  const added = await addVersion(c.env.DB, id, base, {
    title: data.title,
    description: artifact.description ?? undefined,
    entry: version.entry,
    files,
    allowConnect: version.allow_connect,
    deviceId: await browserDevice(c),
    text: htmls.map(pageText).join("\n").slice(0, MAX_TEXT_CHARS),
    links: [...new Set(htmls.flatMap((h) => pageLinks(h, origin)))].slice(0, 1000),
  });
  if (!added) return c.json({ error: "version_conflict", current_version: (await getArtifact(c.env.DB, id))?.current_version ?? base + 1 }, 409);
  const viewer = c.get("viewer");
  await recordViewerAction(c, "artifact.update", "artifact", id, { version: base + 1, browser: true, merged, files: Object.keys(changes).length });
  indexLater(semanticEnv(c.env), c.executionCtx, id);
  await record(c.env.DB, { artifactId: id, project: artifact.project, kind: "updated", actor: { userId: viewer.userId, name: viewer.name }, version: base + 1 });
  await setWatch(c.env.DB, viewer.userId, pageTarget(id), true);
  await leave(c.env.DB, id, viewer.userId);
  return c.json({ version: base + 1, merged });
}

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
  const [author] = await versionAuthors(c.env.DB, id);
  return c.json({ version: latest, by: authorLabel(author), editing: await editing(c.env.DB, id, viewer.userId) });
});

// --- Comments ---

const commentForm = [requireViewer("viewer", true), requireSameOriginForm()] as const;

/** A comment on a page, or a reply in one of its threads; a passage quoted from the page starts a thread on it. */
/** The comments panel was opened: the notifications about this page's comments are answered. */
pages.post("/a/:id/seen", requireViewer(), requireSameOriginJson(), async (c) => {
  const id = c.req.param("id");
  const viewer = c.get("viewer");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact || !(await canSeePage(c.env.DB, viewer, artifact))) return c.json({ error: "not found" }, 404);
  const marked = await markSeen(c.env.DB, viewer.userId, id, { comments: true });
  return c.json({ unread: Math.max(0, viewer.unread - marked) });
});

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
    actor: { userId: viewer.userId, name: viewer.name }, commentId: cid, mentions,
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
.feed .quote { flex-basis: 100%; color: var(--text-2); font-size: var(--text-sm); font-weight: 400; border-left: 3px solid var(--border-strong); padding-left: var(--space-2); white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.feed li.unread .quote { color: var(--text); }
.feed .quote { order: 10; }
`;

/** "Kiho's agent (work-laptop) changed Handbook", linking to the page or its comment, with the comment's text. */
function ActivityLine(props: { a: ActivityRow; href?: string; project?: boolean }) {
  const { a } = props;
  const t = LIST;
  const who = actorLabel(a);
  const page = <a href={props.href ?? activityHref(a)}>{a.title}</a>;
  return (
    <>
      <span class="what">
        {t.did[a.kind](who, page)}
        {a.kind === "updated" && a.version !== null && a.version > 1 && (
          <>
            {" · "}
            <a class="muted small" href={`/a/${a.artifact_id}/diff?from=${a.version - 1}&to=${a.version}`}>
              {t.changes}
            </a>
          </>
        )}
      </span>
      {props.project && a.page_project && <span class="badge">{a.page_project}</span>}
      {a.comment_body && a.kind !== "resolved" && <span class="quote">{a.comment_body.length > 160 ? `${a.comment_body.slice(0, 160)}…` : a.comment_body}</span>}
    </>
  );
}

pages.get("/notifications", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const t = LIST;
  const access = await accessFor(c.env.DB, viewer);
  const rows = (await listNotifications(c.env.DB, viewer.userId)).filter((n) => access.sees({ id: n.artifact_id, project: n.page_project }));
  return c.html(
    <Page title={t.notificationsTitle} viewer={viewer}>
      <style>{raw(ACTIVITY_STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>{t.notificationsTitle}</h1>
          <p class="lead">{t.notificationsLead}</p>
        </div>
        {viewer.unread > 0 && viewer.sessionKind === "full" && (
          <form method="post" action="/notifications/read">
            <CsrfField token={viewer.csrf} />
            <button type="submit">{t.markAll}</button>
          </form>
        )}
      </div>
      {rows.length === 0 ? (
        <p class="muted">{t.nothingNotified}</p>
      ) : (
        <ul class="feed">
          {rows.map((n) => (
            <li class={n.read_at ? undefined : "unread"}>
              <ActivityLine a={n} href={`/notifications/${n.notification_id}/open`} project />
              <span class="badge why">{t.reason[n.reason]}</span>
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

/** What changed lately: everywhere, or in one project (?project=); ?before= goes further back. */
pages.get("/activity", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const t = LIST;
  const access = await accessFor(c.env.DB, viewer);
  const wanted = (c.req.query("project") ?? "").trim();
  const project = wanted && projectSchema.safeParse(wanted).success && !access.hiddenProjects.has(wanted) ? wanted : undefined;
  const before = c.req.query("before");
  const at = before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : undefined;
  const LIMIT = 100;
  const found = await listActivity(c.env.DB, { limit: LIMIT, project, before: at });
  const rows = found.filter((a) => access.sees({ id: a.artifact_id, project: a.page_project }));
  const projects = visibleProjects(await listProjectStats(c.env.DB), access).flatMap((p) => (p.project ? [p.project] : [])).sort((a, b) => a.localeCompare(b));
  const here = (extra: string) => `/activity?${project ? `project=${encodeURIComponent(project)}&` : ""}${extra}`;
  return c.html(
    <Page title={t.activityTitle} viewer={viewer}>
      <style>{raw(ACTIVITY_STYLES + PROJECT_STYLES + TREE_STYLES)}</style>
      <h1>{t.activityTitle}</h1>
      <p class="lead">{project ? t.activityProjectLead(project) : t.activityLead}</p>
      <nav class="label-strip" aria-label={t.projects}>
        <a class={`chip${project ? "" : " current"}`} href="/activity">
          {t.everything}
        </a>
        {projects.map((p) => (
          <a class={`chip${p === project ? " current" : ""}`} href={`/activity?project=${encodeURIComponent(p)}`}>
            {p}
          </a>
        ))}
      </nav>
      <ul class="feed">
        {rows.map((a) => (
          <li>
            <ActivityLine a={a} project={!project} />
            <span class="when">
              <Time iso={a.at} />
            </span>
          </li>
        ))}
      </ul>
      {found.length === LIMIT && (
        <a class="more-link" href={here(`before=${encodeURIComponent(found[found.length - 1]!.at)}`)}>
          {t.older}
        </a>
      )}
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
  return c.redirect(`/a/${id}?move=1`, 303);
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
  return c.redirect(`/a/${id}?move=1`, 303);
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
  return c.redirect(`/a/${id}?move=1`, 303);
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
  // As on the viewer page, the frame keeps this URL while the page is open and renews its lease.
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, artifact.id, version.version, artifact.share_nonce, undefined, true);
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
          <a id="open" href={`${c.req.path}/open`} target="_blank" rel="noopener noreferrer" class="tool" title="Open in a new tab">
            ↗ <span class="label">Open</span>
          </a>
        </div>
        <iframe id="frame" src={src} sandbox={SANDBOX_FLAGS} title={artifact.title} />
        <script nonce={c.get("nonce")}>{raw(FRAGMENT_INTO_FRAME)}</script>
        <script nonce={c.get("nonce")}>
          {raw(`
if (location.hash) document.getElementById("open").href += location.hash;
const lease = { url: location.pathname + "/lease", token: ${JSON.stringify(token)}, exp: ${exp} };
async function refresh() {
  if (Date.now() / 1000 < lease.exp - 120) return;
  try {
    const res = await fetch(lease.url, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: lease.token }) });
    if (res.ok) lease.exp = (await res.json()).exp;
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);`)}
        </script>
      </body>
    </html>,
  );
});

/** Renews the lease of a public page's frame URL. It still stops at once when the link is turned off. */
pages.post("/s/:id/:key/lease", async (c) => {
  noIndex(c);
  const artifact = await sharedArtifact(c);
  if (!artifact) return c.json({ error: LINK_GONE }, 404);
  const body: { token?: unknown } = await c.req.json().catch(() => ({}));
  const claims = typeof body.token === "string" ? await signedContentClaims(c.env.CONTENT_TOKEN_SECRET, body.token) : undefined;
  if (!claims?.l || claims.a !== artifact.id || claims.s !== artifact.share_nonce) return c.json({ error: "That is not the lease of this page." }, 400);
  return c.json({ exp: await renewContentLease(c.env.DB, claims.l) });
});

/** "Open in a new tab" on a public page: a fresh content URL of the latest version. */
pages.get("/s/:id/:key/open", async (c) => {
  noIndex(c);
  const artifact = await sharedArtifact(c);
  if (!artifact) return c.text(LINK_GONE, 404);
  const version = await getVersion(c.env.DB, artifact.id, artifact.current_version);
  if (!version) return c.text(LINK_GONE, 404);
  const { token } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, artifact.id, version.version, artifact.share_nonce);
  return c.redirect(frameSrc(token, version.entry), 302);
});

/** A fresh content URL. Public pages opened before their frames had leases reload their frame with it. */
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
  // Its vault key can no longer open anything new; collections it could read should be rotated (`artifact vault rotate`).
  await revokeMembersOfDevice(c.env.DB, id);
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
