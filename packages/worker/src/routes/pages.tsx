import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { AppEnv } from "../app-env.ts";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { passkeyLabel, registrationOptions, takeCeremony, verifyRegistration } from "../auth/passkeys.ts";
import { requireSameOriginForm, requireSameOriginJson, requireViewer } from "../auth/session.ts";
import { mintContentToken } from "../content.ts";
import {
  getArtifact,
  getVersion,
  listArtifacts,
  listConnecting,
  listTrash,
  listVersions,
  restoreArtifact,
  revokeConnect,
} from "../db/artifacts.ts";
import {
  INVITE_DAYS,
  createInvite,
  createLoginLink,
  deleteUser,
  insertPasskey,
  listOpenInvites,
  listPasskeys,
  listUsers,
} from "../db/users.ts";
import { randomId } from "../lib/encoding.ts";
import { renderSVG } from "uqr";
import { pageSecurity } from "../ui/security.ts";
import { CsrfField, Page, TOKENS, Time, formatTime } from "../ui/layout.tsx";

export const pages = new Hono<AppEnv>();

pages.use(pageSecurity);

// --- List ---

pages.get("/", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const artifacts = await listArtifacts(c.env.DB, 200);
  return c.html(
    <Page title="Artifacts" viewer={viewer}>
      <div class="page-head">
        <div>
          <h1>Artifacts</h1>
          <p class="lead">
            {artifacts.length} {artifacts.length === 1 ? "page" : "pages"}, newest first
          </p>
        </div>
        {artifacts.length > 0 && <input id="filter" class="search" type="search" placeholder="Search" aria-label="Search titles and descriptions" />}
      </div>
      {artifacts.length === 0 ? (
        <div class="card">
          <h2>Nothing published yet</h2>
          <p class="muted small" style="margin:var(--space-2) 0 0">
            Ask an agent for a page, for example “turn this CSV into a dashboard page”. It publishes with the <code>artifact</code> tool and
            the page appears here.
          </p>
        </div>
      ) : (
        <>
          <ul class="rows links" id="artifacts">
            {artifacts.map((a) => (
              <li data-text={`${a.title} ${a.description ?? ""}`.toLowerCase()}>
                <div class="main">
                  <a class="title" href={`/a/${a.id}`}>
                    {a.title}
                  </a>{" "}
                  {a.allow_connect.length > 0 && (
                    <span class="badge warn" title={`May connect to ${a.allow_connect.join(", ")}`}>
                      external
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
iframe { flex: 1; width: 100%; border: 0; background: #fff; }
.short { display: none; }
@media (max-width: 640px) {
  .meta, .label, .divider { display: none; }
  .short { display: inline; }
}
`;

async function viewerPage(c: Context<AppEnv>, id: string, requested: number | undefined) {
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact) return c.notFound();
  const versionNumber = requested ?? artifact.current_version;
  const version = await getVersion(c.env.DB, id, versionNumber);
  if (!version) return c.notFound();
  const versions = await listVersions(c.env.DB, id);
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
        <style>{raw(TOKENS + VIEWER_STYLES)}</style>
      </head>
      <body>
        <div class="bar">
          <a href="/" class="back" aria-label="All artifacts">
            ← <span class="label">Artifacts</span>
          </a>
          <span class="divider" aria-hidden="true" />
          <span class="title">{artifact.title}</span>
          <span class="meta">
            {isLatest ? `v${versionNumber}` : <span class="old">v{versionNumber} (latest is v{artifact.current_version})</span>} ·{" "}
            <Time iso={version.created_at} />
          </span>
          {version.allow_connect.length > 0 && (
            <span class="badge" title={`May connect to ${version.allow_connect.join(", ")}`}>
              external
            </span>
          )}
          <span class="spacer" />
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
        <iframe id="frame" src={src} sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals" title={artifact.title} />
        <script nonce={nonce}>
          {raw(`
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
setInterval(refresh, 60000);`)}
        </script>
      </body>
    </html>,
  );
}

pages.get("/a/:id", requireViewer(), (c) => viewerPage(c, c.req.param("id"), undefined));

pages.get("/a/:id/v/:version{[0-9]+}", requireViewer(), (c) => viewerPage(c, c.req.param("id"), Number(c.req.param("version"))));

/** A fresh content URL for the viewer page, before its token expires. */
pages.get("/a/:id/token", requireViewer(), async (c) => {
  const id = c.req.param("id");
  const artifact = await getArtifact(c.env.DB, id);
  if (!artifact) return c.json({ error: "not found" }, 404);
  const version = await getVersion(c.env.DB, id, Number(c.req.query("v") ?? artifact.current_version));
  if (!version) return c.json({ error: "not found" }, 404);
  const { token, exp } = await mintContentToken(c.env.CONTENT_TOKEN_SECRET, id, version.version);
  return c.json({ src: `/c/${token}/${encodeURI(version.entry)}`, exp });
});

// --- Account (everyone): your passkeys ---

const account = new Hono<AppEnv>();
account.use(requireViewer());

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
  return c.json({ next: "/account#passkeys" });
});

account.post("/account/phone-link", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const token = await createLoginLink(c.env.DB, viewer.userId, "/account#passkeys");
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
  return c.redirect("/account", 303);
});

account.post("/account/passkeys/:id/remove", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const passkeys = await listPasskeys(c.env.DB, viewer.userId);
  if (passkeys.length <= 1) return c.text("Add another passkey before removing your last one.", 400);
  await c.env.DB.prepare("delete from passkeys where id = ? and user_id = ?").bind(c.req.param("id"), viewer.userId).run();
  return c.redirect("/account#passkeys", 303);
});

pages.route("/", account);

// --- Settings (root only) ---

const root = new Hono<AppEnv>();
root.use(requireViewer("root"));

root.get("/settings", async (c) => {
  const viewer = c.get("viewer");
  const [users, invitesOpen, devices, connecting, trash] = await Promise.all([
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
              Computers whose agents can publish. Add one with <code>artifact login</code>. A device can also sign you in here with{" "}
              <code>artifact open</code>, so revoke any you no longer use.
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
    </Page>,
  );
});

root.post("/settings/invites", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const token = await createInvite(c.env.DB, "viewer", viewer.userId);
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
  await c.env.DB.prepare("delete from invites where used_at is null").run();
  return c.redirect("/settings#people", 303);
});

root.post("/settings/users/:id/remove", requireSameOriginForm(), async (c) => {
  const id = c.req.param("id");
  if (id === c.get("viewer").userId) return c.text("You cannot remove yourself.", 400);
  await deleteUser(c.env.DB, id);
  return c.redirect("/settings#people", 303);
});

root.post("/settings/devices/:id/revoke", requireSameOriginForm(), async (c) => {
  await c.env.DB.prepare("update devices set revoked_at = ? where id = ?").bind(new Date().toISOString(), c.req.param("id")).run();
  return c.redirect("/settings#devices", 303);
});

root.post("/settings/connect/:id/revoke", requireSameOriginForm(), async (c) => {
  await revokeConnect(c.env.DB, c.req.param("id"));
  return c.redirect("/settings#external", 303);
});

root.post("/settings/trash/:id/restore", requireSameOriginForm(), async (c) => {
  await restoreArtifact(c.env.DB, c.req.param("id"));
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
    await c.env.DB.batch([
      c.env.DB.prepare("insert into devices (id, name, public_key, created_at, user_id) values (?, ?, ?, ?, ?)").bind(
        deviceId,
        pairing.name,
        pairing.public_key,
        new Date().toISOString(),
        viewer.userId,
      ),
      c.env.DB.prepare("update pairings set status = 'approved', device_id = ? where code = ? and status = 'pending'").bind(deviceId, pairing.code),
    ]);
  } else {
    await c.env.DB.prepare("update pairings set status = 'denied' where code = ?").bind(pairing.code).run();
  }
  return c.html(
    <Page title="Device" viewer={viewer} narrow>
      <h1>{decision === "approve" ? `${pairing.name} can now publish` : "Denied"}</h1>
      <p class="muted">You can close this tab and go back to the terminal.</p>
    </Page>,
  );
});

pages.route("/", root);
