import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-env.ts";
import { authorizeUrl, codeChallengeFor, exchangeCode, verifyIdToken } from "../auth/google.ts";
import { endSession, requireSameOriginForm, requireViewer, roleOf, startSession } from "../auth/session.ts";
import { randomToken, sha256Hex } from "../lib/encoding.ts";
import { sign, verify } from "../lib/signed.ts";
import { Page } from "../ui/layout.tsx";

const OAUTH_COOKIE = "__Host-article_oauth";
const OAUTH_SECONDS = 10 * 60;

interface OAuthState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

export const auth = new Hono<AppEnv>();

/** Only same-site paths, so a crafted link cannot bounce the user elsewhere after sign-in. */
function safeNext(next: string | undefined): string {
  return next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function redirectUri(c: Context<AppEnv>): string {
  return `${c.get("config").origin}/auth/callback`;
}

function message(c: Context<AppEnv>, title: string, body: string, status: 400 | 403 | 500) {
  return c.html(
    <Page title={title}>
      <h1>{title}</h1>
      <p>{body}</p>
      <p>
        <a href="/auth/login">Try again</a>
      </p>
    </Page>,
    status,
  );
}

/**
 * After sign-in the browser is still on a navigation that started at Google, so it would not
 * send our SameSite=Strict session cookie on a redirect. A page that moves on by itself starts
 * a fresh same-site navigation, which does.
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

auth.get("/login", async (c) => {
  const config = c.get("config");
  const next = safeNext(c.req.query("next"));
  if (config.devLoginEmail) {
    await startSession(c, config.devLoginEmail);
    return c.redirect(next);
  }
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId || !c.env.GOOGLE_CLIENT_SECRET) {
    return message(c, "Sign-in is not configured", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for this deployment.", 500);
  }
  const pending: OAuthState = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(),
    next,
    exp: Math.floor(Date.now() / 1000) + OAUTH_SECONDS,
  };
  // Lax: this cookie must come back on the top-level redirect from Google.
  setCookie(c, OAUTH_COOKIE, await sign(pending, c.env.SESSION_SECRET), {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: OAUTH_SECONDS,
  });
  return c.redirect(
    authorizeUrl({
      clientId,
      redirectUri: redirectUri(c),
      state: pending.state,
      nonce: await sha256Hex(pending.nonce),
      codeChallenge: await codeChallengeFor(pending.verifier),
    }),
  );
});

auth.get("/callback", async (c) => {
  const cookie = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: "/", secure: true });
  const pending = cookie ? await verify<OAuthState>(cookie, c.env.SESSION_SECRET) : undefined;
  if (!pending || c.req.query("state") !== pending.state) {
    return message(c, "Sign-in expired", "The sign-in took too long or was started in another browser.", 400);
  }
  if (c.req.query("error")) return message(c, "Sign-in cancelled", "Google did not complete the sign-in.", 400);
  const code = c.req.query("code");
  if (!code) return message(c, "Sign-in failed", "Google returned no authorization code.", 400);

  let email: string;
  try {
    const idToken = await exchangeCode({
      code,
      clientId: c.env.GOOGLE_CLIENT_ID!,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET!,
      redirectUri: redirectUri(c),
      codeVerifier: pending.verifier,
    });
    const claims = await verifyIdToken(idToken, { clientId: c.env.GOOGLE_CLIENT_ID!, nonce: pending.nonce });
    if (!claims.email || claims.email_verified !== true) {
      return message(c, "Email not verified", "This Google account has no verified email address.", 403);
    }
    email = claims.email.toLowerCase();
  } catch (e) {
    console.error("auth.callback_failed", String(e));
    return message(c, "Sign-in failed", "Google's response could not be verified.", 400);
  }

  if (!(await roleOf(c.env.DB, c.get("config"), email))) {
    return message(c, "No access", `${email} has not been given access. Ask the owner to add you as a viewer.`, 403);
  }
  await startSession(c, email);
  return continueTo(c, pending.next);
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
