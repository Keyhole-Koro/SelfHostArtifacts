import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createInvite } from "../src/db/users.ts";
import { softPasskey, type SoftPasskey } from "./authenticator.ts";
import { ORIGIN, browserGet, browserPost, createDevice, sessionCookie, signedJson } from "./helpers.ts";

/** Cookie header value from a response's Set-Cookie (name=value only). */
function cookieFrom(res: Response, name: string): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!header) throw new Error(`no ${name} cookie`);
  return header.split(";")[0]!;
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Opens an invite and creates a user with a new passkey; returns the session cookie. */
async function acceptInvite(token: string, name: string, key: SoftPasskey): Promise<{ res: Response; session?: string }> {
  const optionsRes = await postJson(`/invite/${token}/options`, { name });
  expect(optionsRes.status).toBe(200);
  const options = await optionsRes.json();
  const challenge = cookieFrom(optionsRes, "__Host-artifact_webauthn");
  const res = await postJson(`/invite/${token}/verify`, { name, response: await key.register(options, ORIGIN) }, { cookie: challenge });
  return { res, session: res.ok ? cookieFrom(res, "__Host-artifact_session") : undefined };
}

async function signInWith(key: SoftPasskey): Promise<Response> {
  const optionsRes = await postJson("/auth/passkey/login/options", {});
  const options = await optionsRes.json();
  const challenge = cookieFrom(optionsRes, "__Host-artifact_webauthn");
  return postJson("/auth/passkey/login/verify?next=/settings", { response: await key.authenticate(options, ORIGIN) }, { cookie: challenge });
}

describe("invites", () => {
  it("lets the owner create a viewer invite that works once", async () => {
    const root = await sessionCookie("root");
    const page = await (await browserPost("/settings/invites", root.cookie, { csrf: root.csrf })).text();
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(page)![1]!;
    expect((await browserGet(`/invite/${token}`)).status).toBe(200);

    const { res, session } = await acceptInvite(token, "Aiko", await softPasskey());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/" });
    const user = await env.DB.prepare("select name, role from users where name = 'Aiko'").first();
    expect(user).toEqual({ name: "Aiko", role: "viewer" });
    expect((await browserGet("/", session)).status).toBe(200);
    expect((await browserGet("/settings", session)).status).toBe(403);

    expect((await browserGet(`/invite/${token}`)).status).toBe(404);
    const again = await postJson(`/invite/${token}/options`, { name: "Someone else" });
    expect(again.status).toBe(404);
  });

  it("makes an owner from an owner invite (the deploy script's link)", async () => {
    const token = await createInvite(env.DB, "root", null);
    const { session } = await acceptInvite(token, "Kiho", await softPasskey());
    expect((await browserGet("/settings", session)).status).toBe(200);
  });

  it("refuses an answer to a different challenge", async () => {
    const token = await createInvite(env.DB, "viewer", null);
    const key = await softPasskey();
    const optionsRes = await postJson(`/invite/${token}/options`, { name: "Mallory" });
    const options = (await optionsRes.json()) as Record<string, unknown>;
    const forged = await key.register({ ...options, challenge: "AAAA" }, ORIGIN);
    const res = await postJson(`/invite/${token}/verify`, { name: "Mallory", response: forged }, { cookie: cookieFrom(optionsRes, "__Host-artifact_webauthn") });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare("select 1 from users where name = 'Mallory'").first()).toBeNull();
  });

  it("refuses passkeys made for another site", async () => {
    const token = await createInvite(env.DB, "viewer", null);
    const key = await softPasskey();
    const optionsRes = await postJson(`/invite/${token}/options`, { name: "Eve" });
    const options = await optionsRes.json();
    const response = await key.register(options, "https://evil.example");
    const res = await postJson(`/invite/${token}/verify`, { name: "Eve", response }, { cookie: cookieFrom(optionsRes, "__Host-artifact_webauthn") });
    expect(res.status).toBe(400);
  });

  it("refuses requests from other origins", async () => {
    const token = await createInvite(env.DB, "viewer", null);
    const res = await postJson(`/invite/${token}/options`, { name: "x" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("signing in with a passkey", () => {
  it("signs in the user the passkey belongs to", async () => {
    const key = await softPasskey();
    await acceptInvite(await createInvite(env.DB, "root", null), "Kiho", key);
    const res = await signInWith(key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/settings" });
    expect((await browserGet("/settings", cookieFrom(res, "__Host-artifact_session"))).status).toBe(200);
    const row = await env.DB.prepare("select counter, last_used_at from passkeys where id = ?").bind(key.id).first<{ counter: number; last_used_at: string }>();
    expect(row?.counter).toBe(1);
    expect(row?.last_used_at).toBeTruthy();
  });

  it("refuses a passkey that is not registered", async () => {
    expect((await signInWith(await softPasskey())).status).toBe(403);
  });

  it("refuses a passkey of a removed user", async () => {
    const key = await softPasskey();
    const { session } = await acceptInvite(await createInvite(env.DB, "viewer", null), "Gone", key);
    const user = await env.DB.prepare("select id from users where name = 'Gone'").first<{ id: string }>();
    const root = await sessionCookie("root");
    await browserPost(`/settings/users/${user!.id}/remove`, root.cookie, { csrf: root.csrf });
    expect((await signInWith(key)).status).toBe(403);
    expect((await browserGet("/", session)).status).toBe(302);
  });

  it("lets a signed-in user add a second passkey", async () => {
    const first = await softPasskey();
    const { session } = await acceptInvite(await createInvite(env.DB, "viewer", null), "Two Keys", first);
    const csrf = /<meta name="csrf" content="([^"]+)"/.exec(await (await browserGet("/account", session)).text())![1]!;
    const optionsRes = await postJson("/account/passkeys/options", {}, { cookie: session!, "x-csrf": csrf });
    expect(optionsRes.status).toBe(200);
    const second = await softPasskey();
    const res = await postJson(
      "/account/passkeys/verify",
      { response: await second.register(await optionsRes.json(), ORIGIN) },
      { cookie: `${session}; ${cookieFrom(optionsRes, "__Host-artifact_webauthn")}`, "x-csrf": csrf },
    );
    expect(res.status).toBe(200);
    expect((await signInWith(second)).status).toBe(200);
  });

  it("needs the CSRF token to add a passkey", async () => {
    const { cookie } = await sessionCookie("viewer");
    expect((await postJson("/account/passkeys/options", {}, { cookie })).status).toBe(403);
  });
});

describe("login links from the CLI", () => {
  async function approvedDevice() {
    const device = await createDevice();
    const owner = await sessionCookie("root");
    await env.DB.prepare("update devices set user_id = ? where id = ?").bind(owner.userId, device.id).run();
    return { device, owner };
  }

  it("signs the browser in as the user who approved the device, once", async () => {
    const { device, owner } = await approvedDevice();
    const created = await signedJson(device, "POST", "/api/v1/login-links", { next: "/a/abc" });
    expect(created.status).toBe(201);
    const { url } = (await created.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${ORIGIN}/auth/link/`));

    const res = await SELF.fetch(url, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="0;url=/a/abc"');
    const session = cookieFrom(res, "__Host-artifact_session");
    const row = await env.DB.prepare("select user_id from sessions where id = ?").bind(session.split("=")[1]).first<{ user_id: string }>();
    expect(row?.user_id).toBe(owner.userId);

    expect((await SELF.fetch(url, { redirect: "manual" })).status).toBe(403);
  });

  it("expires after two minutes", async () => {
    const { device } = await approvedDevice();
    const { url } = (await (await signedJson(device, "POST", "/api/v1/login-links", {})).json()) as { url: string };
    await env.DB.prepare("update login_links set expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await SELF.fetch(url, { redirect: "manual" })).status).toBe(403);
  });

  it("does not send the browser off the site", async () => {
    const { device } = await approvedDevice();
    const { url } = (await (await signedJson(device, "POST", "/api/v1/login-links", { next: "//evil.example" })).json()) as { url: string };
    expect(await (await SELF.fetch(url, { redirect: "manual" })).text()).toContain('content="0;url=/"');
  });

  it("needs a signed request", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/login-links`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
