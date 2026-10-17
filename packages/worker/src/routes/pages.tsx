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
  createUser,
  deleteUser,
  insertPasskey,
  listOpenInvites,
  listPasskeys,
  listUsers,
  userByEmail,
} from "../db/users.ts";
import { randomId } from "../lib/encoding.ts";
import { pageSecurity } from "../ui/security.ts";
import { CsrfField, Page, formatTime } from "../ui/layout.tsx";

export const pages = new Hono<AppEnv>();

pages.use(pageSecurity);

// --- List ---

pages.get("/", requireViewer(), async (c) => {
  const viewer = c.get("viewer");
  const artifacts = await listArtifacts(c.env.DB, 200);
  return c.html(
    <Page title="Artifacts" viewer={viewer}>
      <div class="row" style="margin-bottom:16px">
        <h1 class="grow" style="margin:0">Artifacts</h1>
      </div>
      {artifacts.length === 0 ? (
        <div class="card muted">
          Nothing is published yet. Ask an agent to publish a page with the <code>artifact</code> tool.
        </div>
      ) : (
        <>
          <input id="filter" type="search" placeholder="Filter by title or description" aria-label="Filter" style="margin-bottom:12px" />
          <ul class="list" id="artifacts">
            {artifacts.map((a) => (
              <li data-text={`${a.title} ${a.description ?? ""}`.toLowerCase()}>
                <div class="row">
                  <a class="title grow" href={`/a/${a.id}`}>
                    {a.title}
                  </a>
                  {a.allow_connect.length > 0 && <span class="badge" title={a.allow_connect.join(", ")}>External access</span>}
                </div>
                {a.description && <div>{a.description}</div>}
                <div class="meta">
                  v{a.current_version} · updated {formatTime(a.updated_at)}
                </div>
              </li>
            ))}
          </ul>
          <script nonce={c.get("nonce")}>
            {raw(`
const input = document.getElementById("filter");
const items = [...document.querySelectorAll("#artifacts li")];
input.addEventListener("input", () => {
  const q = input.value.trim().toLowerCase();
  for (const li of items) li.hidden = q !== "" && !li.dataset.text.includes(q);
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
body { display: flex; flex-direction: column; background: var(--bg, #fff); }
.bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid #e7e5e4; font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #1c1917; }
.bar a { color: #2563eb; text-decoration: none; }
.bar .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bar .meta { color: #78716c; white-space: nowrap; }
.bar .spacer { flex: 1; }
.bar details { position: relative; }
.bar summary { cursor: pointer; color: #2563eb; list-style: none; }
.bar details ul { position: absolute; right: 0; top: 24px; z-index: 1; list-style: none; margin: 0; padding: 6px 0; background: #fff; border: 1px solid #e7e5e4; border-radius: 8px; min-width: 220px; max-height: 60vh; overflow: auto; }
.bar details li a { display: block; padding: 4px 12px; color: #1c1917; }
.bar details li a.current { font-weight: 600; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; white-space: nowrap; }
iframe { flex: 1; width: 100%; border: 0; background: #fff; }
@media (prefers-color-scheme: dark) {
  .bar, .bar details ul { background: #1c1917; color: #f5f5f4; border-color: #292524; }
  .bar details li a { color: #f5f5f4; }
  .bar .meta { color: #a8a29e; }
  .badge { background: #422006; color: #fcd34d; }
}
@media (max-width: 640px) {
  .bar .meta, .bar .optional { display: none; }
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
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{artifact.title}</title>
        <style>{raw(VIEWER_STYLES)}</style>
      </head>
      <body>
        <div class="bar">
          <a href="/" class="optional" aria-label="All artifacts">
            ←
          </a>
          <span class="title">{artifact.title}</span>
          <span class="meta">
            v{versionNumber}
            {versionNumber !== artifact.current_version && ` (latest is v${artifact.current_version})`} ·{" "}
            {formatTime(version.created_at)}
          </span>
          {version.allow_connect.length > 0 && (
            <span class="badge" title={version.allow_connect.join(", ")}>
              External access
            </span>
          )}
          <span class="spacer" />
          <details>
            <summary>Versions</summary>
            <ul>
              {versions.map((v) => (
                <li>
                  <a href={v.version === artifact.current_version ? `/a/${id}` : `/a/${id}/v/${v.version}`} class={v.version === versionNumber ? "current" : ""}>
                    v{v.version} · {formatTime(v.created_at)}
                  </a>
                </li>
              ))}
            </ul>
          </details>
          <a id="open" href={src} target="_blank" rel="noopener noreferrer" class="optional">
            Open in new tab
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
      <h1>{viewer.name}</h1>
      <p class="muted">{viewer.role === "root" ? "Owner" : "Viewer"}</p>

      <h2 id="name">Name</h2>
      <form method="post" action="/account/name" class="row">
        <CsrfField token={viewer.csrf} />
        <input class="grow" type="text" name="name" required maxlength={64} value={viewer.name} aria-label="Name" autocomplete="name" />
        <button type="submit">Save</button>
      </form>

      <h2 id="passkeys">Passkeys</h2>
      <p class="muted">Each passkey lets you sign in from the device or password manager that holds it. Add one per device you use.</p>
      <ul class="list" style="margin-bottom:12px">
        {passkeys.length === 0 && <li class="muted">No passkeys yet.</li>}
        {passkeys.map((p) => (
          <li class="row">
            <span class="grow">
              <strong>{p.label}</strong>
              <div class="meta">
                added {formatTime(p.created_at)}
                {p.last_used_at && ` · last used ${formatTime(p.last_used_at)}`}
              </div>
            </span>
            {passkeys.length > 1 && (
              <form class="inline" method="post" action={`/account/passkeys/${encodeURIComponent(p.id)}/remove`}>
                <CsrfField token={viewer.csrf} />
                <button class="danger" type="submit">
                  Remove
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <button type="button" data-passkey="register" data-options="/account/passkeys/options" data-verify="/account/passkeys/verify">
        Add a passkey
      </button>
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
  const google = Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
  return c.html(
    <Page title="Settings" viewer={viewer}>
      <h1>Settings</h1>

      <h2 id="people">People</h2>
      <p class="muted">Viewers can open every artifact. Invite someone with a link; they create a passkey when they open it.</p>
      <ul class="list" style="margin-bottom:12px">
        {users.map((u) => (
          <li class="row">
            <span class="grow">
              <strong>{u.name}</strong> <span class="badge">{u.role === "root" ? "Owner" : "Viewer"}</span>
              <div class="meta">
                {u.passkeys} passkey{u.passkeys === 1 ? "" : "s"}
                {u.email && ` · Google: ${u.email}`}
              </div>
            </span>
            {u.id !== viewer.userId && (
              <form class="inline" method="post" action={`/settings/users/${u.id}/remove`}>
                <CsrfField token={viewer.csrf} />
                <button class="danger" type="submit">
                  Remove
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <div class="row">
        <form class="inline" method="post" action="/settings/invites">
          <CsrfField token={viewer.csrf} />
          <button class="primary" type="submit">
            Create invite link
          </button>
        </form>
      </div>
      {invitesOpen.length > 0 && (
        <p class="muted">
          {invitesOpen.length} invite link{invitesOpen.length === 1 ? "" : "s"} not used yet ·{" "}
          <form class="inline" method="post" action="/settings/invites/revoke">
            <CsrfField token={viewer.csrf} />
            <button type="submit">Cancel unused links</button>
          </form>
        </p>
      )}
      {google && (
        <form method="post" action="/settings/google" class="row" style="margin-top:12px">
          <CsrfField token={viewer.csrf} />
          <input class="grow" type="email" name="email" required placeholder="name@gmail.com" aria-label="Google account" />
          <button type="submit">Add by Google account</button>
        </form>
      )}

      <h2 id="devices">Devices</h2>
      <p class="muted">
        Computers whose agents can publish. Add one with <code>artifact login</code>. A device can also sign you in here with <code>artifact open</code>.
      </p>
      <ul class="list">
        {devices.results.length === 0 && <li class="muted">No devices yet.</li>}
        {devices.results.map((d) => (
          <li class="row">
            <span class="grow">
              <strong>{d.name}</strong>
              <div class="meta">
                added {formatTime(d.created_at)}
                {d.last_used_at && ` · last used ${formatTime(d.last_used_at)}`}
              </div>
            </span>
            <form class="inline" method="post" action={`/settings/devices/${d.id}/revoke`}>
              <CsrfField token={viewer.csrf} />
              <button class="danger" type="submit">
                Revoke
              </button>
            </form>
          </li>
        ))}
      </ul>

      <h2 id="external">External access</h2>
      <p class="muted">Artifacts that may send requests to other hosts. Removing access lasts until the artifact is published again with it.</p>
      <ul class="list">
        {connecting.length === 0 && <li class="muted">None.</li>}
        {connecting.map((a) => (
          <li class="row">
            <span class="grow">
              <a class="title" href={`/a/${a.id}`}>
                {a.title}
              </a>
              <div class="meta">{a.allow_connect.join(", ")}</div>
            </span>
            <form class="inline" method="post" action={`/settings/connect/${a.id}/revoke`}>
              <CsrfField token={viewer.csrf} />
              <button class="danger" type="submit">
                Remove access
              </button>
            </form>
          </li>
        ))}
      </ul>

      <h2 id="trash">Trash</h2>
      <p class="muted">Deleted artifacts are removed for good {trashDays} days after deletion.</p>
      <ul class="list">
        {trash.length === 0 && <li class="muted">Empty.</li>}
        {trash.map((a) => (
          <li class="row">
            <span class="grow">
              <strong>{a.title}</strong>
              <div class="meta">deleted {formatTime(a.deleted_at!)}</div>
            </span>
            <form class="inline" method="post" action={`/settings/trash/${a.id}/restore`}>
              <CsrfField token={viewer.csrf} />
              <button type="submit">Restore</button>
            </form>
          </li>
        ))}
      </ul>
    </Page>,
  );
});

root.post("/settings/invites", requireSameOriginForm(), async (c) => {
  const viewer = c.get("viewer");
  const token = await createInvite(c.env.DB, "viewer", viewer.userId);
  const url = `${c.get("config").origin}/invite/${token}`;
  return c.html(
    <Page title="Invite link" viewer={viewer}>
      <h1>Invite link</h1>
      <p>Send this link to the person you want to add. It works once and expires in {INVITE_DAYS} days.</p>
      <p class="link-box">{url}</p>
      <p class="muted">The link is shown only now. Anyone who opens it first becomes a viewer.</p>
      <p>
        <a href="/settings#people">Back to settings</a>
      </p>
    </Page>,
  );
});

root.post("/settings/invites/revoke", requireSameOriginForm(), async (c) => {
  await c.env.DB.prepare("delete from invites where used_at is null").run();
  return c.redirect("/settings#people", 303);
});

root.post("/settings/google", requireSameOriginForm(), async (c) => {
  const email = String((await c.req.parseBody())["email"] ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.text("That is not an email address.", 400);
  if (!(await userByEmail(c.env.DB, email))) await createUser(c.env.DB, { name: email, role: "viewer", email });
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
      <Page title="Login request" viewer={viewer}>
        <h1>{closed.title}</h1>
        <p class="muted">{closed.body}</p>
      </Page>,
      row ? 200 : 404,
    );
  }
  const pairing = row;
  return c.html(
    <Page title="Approve device" viewer={viewer}>
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
    <Page title="Device" viewer={viewer}>
      <h1>{decision === "approve" ? `${pairing.name} can now publish` : "Denied"}</h1>
      <p class="muted">You can close this tab and go back to the terminal.</p>
    </Page>,
  );
});

pages.route("/", root);
