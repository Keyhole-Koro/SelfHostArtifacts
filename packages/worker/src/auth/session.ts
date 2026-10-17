import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Role, Viewer } from "../app-env.ts";
import { randomToken } from "../lib/encoding.ts";

export const SESSION_COOKIE = "__Host-artifact_session";
const SESSION_DAYS = 30;

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const id = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await c.env.DB.prepare("insert into sessions (id, user_id, csrf, expires_at) values (?, ?, ?, ?)")
    .bind(id, userId, randomToken(), expires.toISOString())
    .run();
  // Strict keeps the cookie off every request a sandboxed artifact can make.
  setCookie(c, SESSION_COOKIE, id, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    expires,
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.env.DB.prepare("delete from sessions where id = ?").bind(id).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

/** The signed-in user. Removing a user deletes their sessions, so access ends at once. */
export async function currentViewer(c: Context<AppEnv>): Promise<Viewer | undefined> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return undefined;
  const row = await c.env.DB.prepare(
    `select s.csrf, s.expires_at, u.id as user_id, u.name, u.role
     from sessions s join users u on u.id = s.user_id where s.id = ?`,
  )
    .bind(id)
    .first<{ csrf: string; expires_at: string; user_id: string; name: string; role: Role }>();
  if (!row || Date.parse(row.expires_at) <= Date.now()) return undefined;
  return { userId: row.user_id, name: row.name, role: row.role, sessionId: id, csrf: row.csrf };
}

function loginRedirect(c: Context<AppEnv>) {
  const next = c.req.path + (new URL(c.req.url).search || "");
  return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`);
}

/** Pages for root and viewers. Anonymous visitors are sent to sign in. */
export function requireViewer(minimum: Role = "viewer"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const viewer = await currentViewer(c);
    if (!viewer) return loginRedirect(c);
    if (minimum === "root" && viewer.role !== "root") return c.text("Only the owner can open this page.", 403);
    c.set("viewer", viewer);
    await next();
  };
}

/**
 * Checks a form POST from our own pages: the Origin must be this host (a sandboxed artifact
 * sends "null") and the CSRF token must match the session.
 */
export function requireSameOriginForm(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("origin") !== c.get("config").origin) return c.text("Cross-origin form submission refused.", 403);
    const body = await c.req.parseBody();
    if (body["csrf"] !== c.get("viewer").csrf) return c.text("The form expired. Go back and reload the page.", 403);
    await next();
  };
}

/** The same check for JSON requests sent by our pages' scripts (CSRF token in a header). */
export function requireSameOriginJson(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("origin") !== c.get("config").origin) return c.json({ error: "Cross-origin request refused." }, 403);
    if (c.req.header("x-csrf") !== c.get("viewer").csrf) return c.json({ error: "Reload the page and try again." }, 403);
    await next();
  };
}
