import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Role, Viewer } from "../app-env.ts";
import type { Config } from "../env.ts";
import { randomToken } from "../lib/encoding.ts";

export const SESSION_COOKIE = "__Host-artifact_session";
const SESSION_DAYS = 30;

export async function roleOf(db: D1Database, config: Config, email: string): Promise<Role | undefined> {
  const normalized = email.trim().toLowerCase();
  if (normalized === config.rootEmail) return "root";
  const member = await db.prepare("select 1 from members where email = ?").bind(normalized).first();
  return member ? "viewer" : undefined;
}

export async function startSession(c: Context<AppEnv>, email: string): Promise<void> {
  const id = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await c.env.DB.prepare("insert into sessions (id, email, csrf, expires_at) values (?, ?, ?, ?)")
    .bind(id, email.toLowerCase(), randomToken(), expires.toISOString())
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

async function currentViewer(c: Context<AppEnv>): Promise<Viewer | undefined> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return undefined;
  const row = await c.env.DB.prepare("select email, csrf, expires_at from sessions where id = ?")
    .bind(id)
    .first<{ email: string; csrf: string; expires_at: string }>();
  if (!row || Date.parse(row.expires_at) <= Date.now()) return undefined;
  // Re-check the role on every request so a removed viewer loses access immediately.
  const role = await roleOf(c.env.DB, c.get("config"), row.email);
  if (!role) return undefined;
  return { email: row.email, role, sessionId: id, csrf: row.csrf };
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
