import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppEnv } from "../app-env.ts";
import { requireSameOriginForm, requireViewer } from "../auth/session.ts";
import { recordAuditEvent } from "../db/audit.ts";
import { listProjectPages } from "../db/artifacts.ts";
import { getSpace, listMembers, removeMember, setMember, updateSpace, type SpaceAccess, type SpaceRole } from "../db/spaces.ts";
import { listUsers } from "../db/users.ts";
import { pageSecurity } from "../ui/security.ts";
import { CsrfField, Page } from "../ui/layout.tsx";

/**
 * A project's settings, for the owner: what it is about, and who may see it. "Everyone" is every
 * viewer, as before; "Members only" is the owner and the viewers listed here. An editor may also
 * change the project's pages from the browser.
 */
export const projectPages = new Hono<AppEnv>();
projectPages.use(pageSecurity);

const owner = [requireViewer("root", true)] as const;
const ownerForm = [requireViewer("root", true), requireSameOriginForm()] as const;

const STYLES = `
.access { display: grid; gap: var(--space-2); margin: var(--space-3) 0; }
.access label { display: flex; gap: var(--space-2); align-items: baseline; }
textarea { width: 100%; min-height: 72px; font: inherit; padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); box-sizing: border-box; }
select { font: inherit; padding: 4px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); }
`;

// c.req.param("name") is already percent-decoded. Decoding it again would fail on "50% off" and
// open the project "a b" for one named "a%20b".
projectPages.get("/:name", ...owner, async (c) => {
  const name = c.req.param("name");
  const viewer = c.get("viewer");
  const [space, members, users, pages] = await Promise.all([
    getSpace(c.env.DB, name),
    listMembers(c.env.DB, name),
    listUsers(c.env.DB),
    listProjectPages(c.env.DB, name),
  ]);
  if (!space && pages.length === 0) return c.notFound();
  const access: SpaceAccess = space?.access ?? "everyone";
  const memberIds = new Set(members.map((m) => m.user_id));
  const candidates = users.filter((u) => u.role !== "root" && !memberIds.has(u.id));
  const href = `/projects/${encodeURIComponent(name)}`;
  return c.html(
    <Page title={`${name} · Settings`} viewer={viewer}>
      <style>{raw(STYLES)}</style>
      <div class="page-head">
        <div>
          <h1>{name}</h1>
          <p class="lead">
            {pages.length} {pages.length === 1 ? "page" : "pages"} · <a href={`/?project=${encodeURIComponent(name)}`}>Open the project</a>
          </p>
        </div>
      </div>
      <section class="section">
        <div class="section-head">
          <h2>About and access</h2>
        </div>
        <form method="post" action={href} class="stack">
          <CsrfField token={viewer.csrf} />
          <label for="description">What this project is about</label>
          <textarea id="description" name="description" maxlength={1000}>
            {space?.description ?? ""}
          </textarea>
          <div class="access" role="radiogroup" aria-label="Who may see it">
            <label>
              <input type="radio" name="access" value="everyone" checked={access === "everyone"} /> Everyone: every viewer sees its pages
            </label>
            <label>
              <input type="radio" name="access" value="members" checked={access === "members"} /> Members only: you and the members below
            </label>
          </div>
          <div>
            <button type="submit" class="primary">
              Save
            </button>
          </div>
        </form>
      </section>
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Members</h2>
            <p class="muted small" style="margin:0">
              {access === "everyone"
                ? "Every viewer sees this project now. Members matter once it is members only, and editors may change its pages from the browser."
                : "Only you and these people see this project's pages. Editors may also change them from the browser."}
            </p>
          </div>
        </div>
        {members.length > 0 ? (
          <ul class="rows">
            {members.map((m) => (
              <li>
                <div class="main">
                  {m.name} <span class="badge">{m.role}</span>
                </div>
                <div class="side">
                  <form class="inline" method="post" action={`${href}/members`}>
                    <CsrfField token={viewer.csrf} />
                    <input type="hidden" name="user" value={m.user_id} />
                    <input type="hidden" name="role" value={m.role === "editor" ? "viewer" : "editor"} />
                    <button type="submit">{m.role === "editor" ? "Make viewer" : "Make editor"}</button>
                  </form>
                  <form class="inline" method="post" action={`${href}/members/remove`}>
                    <CsrfField token={viewer.csrf} />
                    <input type="hidden" name="user" value={m.user_id} />
                    <button type="submit">Remove</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted small">No members yet.</p>
        )}
        {candidates.length > 0 ? (
          <form method="post" action={`${href}/members`} class="field-row" style="margin-top:var(--space-4)">
            <CsrfField token={viewer.csrf} />
            <select name="user" aria-label="Person">
              {candidates.map((u) => (
                <option value={u.id}>{u.name}</option>
              ))}
            </select>
            <select name="role" aria-label="Role">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button type="submit" class="primary">
              Add
            </button>
          </form>
        ) : (
          <p class="muted small">
            Everyone you invited is a member. Invite more people in <a href="/settings">Settings</a>.
          </p>
        )}
      </section>
    </Page>,
  );
});

projectPages.post("/:name", ...ownerForm, async (c) => {
  const name = c.req.param("name");
  const form = await c.req.parseBody();
  const description = typeof form["description"] === "string" ? form["description"].trim().slice(0, 1000) : "";
  const access: SpaceAccess = form["access"] === "members" ? "members" : "everyone";
  if ((await listProjectPages(c.env.DB, name)).length === 0 && !(await getSpace(c.env.DB, name))) return c.notFound();
  await updateSpace(c.env.DB, name, { description: description || null, access });
  const viewer = c.get("viewer");
  await recordAuditEvent(c, {
    actorType: "user", actorId: viewer.userId, actorLabel: viewer.name,
    action: "project.update", targetType: "project", targetId: name, metadata: { access },
  });
  return c.redirect(`/projects/${encodeURIComponent(name)}`, 303);
});

projectPages.post("/:name/members", ...ownerForm, async (c) => {
  const name = c.req.param("name");
  const form = await c.req.parseBody();
  const userId = typeof form["user"] === "string" ? form["user"] : "";
  const role: SpaceRole = form["role"] === "editor" ? "editor" : "viewer";
  const users = await listUsers(c.env.DB);
  const user = users.find((u) => u.id === userId);
  if (!user || user.role === "root") return c.text("Choose one of the people you invited.", 400);
  await setMember(c.env.DB, name, userId, role);
  const viewer = c.get("viewer");
  await recordAuditEvent(c, {
    actorType: "user", actorId: viewer.userId, actorLabel: viewer.name,
    action: "project.member", targetType: "project", targetId: name, metadata: { user: userId, role },
  });
  return c.redirect(`/projects/${encodeURIComponent(name)}`, 303);
});

projectPages.post("/:name/members/remove", ...ownerForm, async (c) => {
  const name = c.req.param("name");
  const form = await c.req.parseBody();
  const userId = typeof form["user"] === "string" ? form["user"] : "";
  await removeMember(c.env.DB, name, userId);
  const viewer = c.get("viewer");
  await recordAuditEvent(c, {
    actorType: "user", actorId: viewer.userId, actorLabel: viewer.name,
    action: "project.member.remove", targetType: "project", targetId: name, metadata: { user: userId },
  });
  return c.redirect(`/projects/${encodeURIComponent(name)}`, 303);
});
