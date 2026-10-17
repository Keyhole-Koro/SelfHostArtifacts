import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import {
  authenticationOptions,
  passkeyLabel,
  registrationOptions,
  takeCeremony,
  verifyAuthentication,
  verifyRegistration,
} from "../auth/passkeys.ts";
import { endSession, requireSameOriginForm, requireViewer, startSession } from "../auth/session.ts";
import type { Config } from "../env.ts";
import {
  consumeLoginLink,
  createUser,
  firstRoot,
  insertPasskey,
  newUserId,
  openInvite,
  useInvite,
  type UserRow,
} from "../db/users.ts";
import { Page } from "../ui/layout.tsx";
import { pageSecurity } from "../ui/security.ts";

export const auth = new Hono<AppEnv>();
auth.use(pageSecurity);

/** Only same-site paths, so a crafted link cannot bounce the user elsewhere after sign-in. */
export function safeNext(next: string | undefined): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function message(c: Context<AppEnv>, title: string, body: string, status: 400 | 403 | 404 | 500) {
  return c.html(
    <Page title={title}>
      <h1>{title}</h1>
      <p>{body}</p>
      <p>
        <a href="/auth/login">Sign in</a>
      </p>
    </Page>,
    status,
  );
}

/**
 * After a navigation that started outside the site (a link opened by the CLI or a QR code), the
 * browser does not send our SameSite=Strict cookie on a redirect. A page that moves on by itself
 * starts a fresh same-site navigation, which does.
 */
function continueTo(c: Context<AppEnv>, next: string) {
  return c.html(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="refresh" content={`0;url=${next}`} />
        <title>Signing in</title>
      </head>
      <body>
        <p>
          Signed in. <a href={next}>Continue</a>
        </p>
      </body>
    </html>,
  );
}

/** JSON endpoints called by our own pages' scripts: refuse other origins (login CSRF). */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header("origin") !== c.get("config").origin) return c.json({ error: "Cross-origin request refused." }, 403);
  await next();
};

async function devUser(db: D1Database, config: Config): Promise<UserRow> {
  const root = await firstRoot(db);
  return root ?? createUser(db, { name: "Owner", role: "root" });
}

// --- Sign-in page ---

auth.get("/login", async (c) => {
  const config = c.get("config");
  const next = safeNext(c.req.query("next"));
  if (config.devLogin) {
    const user = await devUser(c.env.DB, config);
    await startSession(c, user.id);
    return c.redirect(next);
  }
  const hasOwner = Boolean(await firstRoot(c.env.DB));
  return c.html(
    <Page title="Sign in" passkeys>
      <h1>Sign in</h1>
      {!hasOwner && (
        <p class="card">
          This deployment has no owner yet. Open the owner link that <code>pnpm run deploy</code> printed.
        </p>
      )}
      <div class="stack">
        <button
          class="primary"
          type="button"
          data-passkey="login"
          data-options="/auth/passkey/login/options"
          data-verify={`/auth/passkey/login/verify?next=${encodeURIComponent(next)}`}
        >
          Sign in with a passkey
        </button>
      </div>
      <p class="muted" style="margin-top:24px">
        No passkey here yet? Open the invite link you were sent; it creates one. If you already have an account, sign in
        another way first (<code>artifact open</code> on a computer set up with <code>artifact</code>, or a QR code from
        your account on another device) and add a passkey under your name.
      </p>
    </Page>,
  );
});

auth.post("/passkey/login/options", sameOrigin, async (c) => c.json(await authenticationOptions(c)));

auth.post("/passkey/login/verify", sameOrigin, async (c) => {
  const ceremony = await takeCeremony(c);
  if (ceremony?.kind !== "login") return c.json({ error: "The sign-in took too long. Try again." }, 400);
  const { response } = (await c.req.json()) as { response: AuthenticationResponseJSON };
  const passkey = await verifyAuthentication(c, ceremony, response);
  if (!passkey) return c.json({ error: "This passkey is not registered here, or it was removed." }, 403);
  await startSession(c, passkey.user_id);
  return c.json({ next: safeNext(c.req.query("next")) });
});

// --- Login links made by `artifact open` ---

auth.get("/link/:token", async (c) => {
  const link = await consumeLoginLink(c.env.DB, c.req.param("token"));
  if (!link) return message(c, "This sign-in link has expired", "Links work once, for two minutes. Run artifact open again.", 403);
  await startSession(c, link.userId);
  return continueTo(c, safeNext(link.next));
});

auth.post("/logout", requireViewer(), requireSameOriginForm(), async (c) => {
  await endSession(c);
  return c.html(
    <Page title="Signed out">
      <h1>Signed out</h1>
      <p>
        <a href="/auth/login">Sign in again</a>
      </p>
    </Page>,
  );
});

// --- Invites: create a user and their first passkey ---

export const invites = new Hono<AppEnv>();
invites.use(pageSecurity);

invites.get("/:token", async (c) => {
  const token = c.req.param("token");
  const invite = await openInvite(c.env.DB, token);
  if (!invite) return message(c, "This invite link has expired", "Invite links work once and expire after 7 days. Ask for a new one.", 404);
  const owner = invite.role === "root";
  return c.html(
    <Page title="Create your passkey" passkeys>
      <h1>{owner ? "Become the owner" : "You're invited to view Artifacts"}</h1>
      <p class="muted">
        {owner
          ? "Create a passkey to sign in. As the owner you approve computers, invite people and manage everything."
          : "Create a passkey to sign in. You will be able to open every artifact here."}
      </p>
      <div class="stack">
        <label for="name">Your name</label>
        <input id="name" type="text" maxlength={64} required placeholder="e.g. Kiho" autocomplete="name" />
        <button class="primary" type="button" data-passkey="register" data-name-input="#name" data-options={`/invite/${token}/options`} data-verify={`/invite/${token}/verify`}>
          Create passkey
        </button>
      </div>
      <p class="muted" style="margin-top:24px">
        Your device asks for a fingerprint, face or screen lock. Nothing else is needed, and no password is stored.
      </p>
    </Page>,
  );
});

function cleanName(raw: unknown): string | undefined {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return name.length >= 1 && name.length <= 64 ? name : undefined;
}

invites.post("/:token/options", sameOrigin, async (c) => {
  const token = c.req.param("token");
  const invite = await openInvite(c.env.DB, token);
  if (!invite) return c.json({ error: "This invite link has expired." }, 404);
  const name = cleanName(((await c.req.json()) as { name?: unknown }).name);
  if (!name) return c.json({ error: "Enter your name first." }, 400);
  return c.json(await registrationOptions(c, { id: newUserId(), name, inviteHash: invite.token_hash }));
});

invites.post("/:token/verify", sameOrigin, async (c) => {
  const token = c.req.param("token");
  const ceremony = await takeCeremony(c);
  const invite = await openInvite(c.env.DB, token);
  if (ceremony?.kind !== "register" || !invite || ceremony.inviteHash !== invite.token_hash) {
    return c.json({ error: "The invite expired or the request took too long. Reload and try again." }, 400);
  }
  const { response } = (await c.req.json()) as { response: RegistrationResponseJSON };
  const passkey = await verifyRegistration(c, ceremony, response);
  if (!passkey) return c.json({ error: "The passkey could not be verified." }, 400);

  const now = new Date().toISOString();
  try {
    // One transaction: claim the invite, then create the user and passkey only if we claimed it.
    await c.env.DB.batch([
      useInvite(c.env.DB, invite.token_hash, ceremony.userId),
      c.env.DB.prepare(
        "insert into users (id, name, role, email, created_at) select ?, ?, ?, null, ? where (select used_by from invites where token_hash = ?) = ?",
      ).bind(ceremony.userId, ceremony.name, invite.role, now, invite.token_hash, ceremony.userId),
      insertPasskey(c.env.DB, {
        id: passkey.id,
        userId: ceremony.userId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports,
        label: passkeyLabel(c.req.header("user-agent")),
      }),
    ]);
  } catch (e) {
    console.warn("invite.accept_failed", String(e));
    return c.json({ error: "This invite was just used by someone else." }, 409);
  }
  await startSession(c, ceremony.userId);
  return c.json({ next: "/" });
});
