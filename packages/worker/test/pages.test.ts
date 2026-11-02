import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { base64url } from "../src/lib/encoding.ts";
import { ORIGIN, ROOT, browserGet, browserPost, createDevice, publish, sessionCookie, signedJson } from "./helpers.ts";

describe("sign-in and roles", () => {
  it("sends anonymous visitors to sign in", async () => {
    const res = await browserGet("/settings");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login?next=%2Fsettings");
  });

  it("dev login (DEV_LOGIN) signs in as the owner with a strict session cookie", async () => {
    const res = await browserGet("/auth/login?next=/settings");
    expect(res.headers.get("location")).toBe("/settings");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-artifact_session=/);
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("does not follow a next parameter off the site", async () => {
    const res = await browserGet("/auth/login?next=//evil.example");
    expect(res.headers.get("location")).toBe("/");
  });

  it("does not follow a next parameter made external by URL control-character normalization", async () => {
    const res = await browserGet("/auth/login?next=%2F%09%2Fevil.example");
    expect(res.headers.get("location")).toBe("/");
  });

  it("sets baseline browser security headers", async () => {
    const res = await browserGet("/auth/login");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("lets a viewer read but not open settings", async () => {
    const { cookie } = await sessionCookie("viewer");
    expect((await browserGet("/", cookie)).status).toBe(200);
    expect((await browserGet("/account", cookie)).status).toBe(200);
    expect((await browserGet("/settings", cookie)).status).toBe(403);
  });

  it("treats sessions inserted by old code during migration as view-only", async () => {
    const root = await sessionCookie(ROOT);
    await env.DB.prepare("insert into sessions (id, user_id, csrf, expires_at) values ('rolling-session', ?, 'csrf', ?)")
      .bind(root.userId, new Date(Date.now() + 60_000).toISOString())
      .run();
    const cookie = "__Host-artifact_session=rolling-session";
    expect((await browserGet("/", cookie)).status).toBe(200);
    expect((await browserGet("/settings", cookie)).status).toBe(302);
  });

  it("drops a session whose user was removed", async () => {
    const viewer = await sessionCookie("viewer");
    await env.DB.prepare("delete from users where id = ?").bind(viewer.userId).run();
    expect((await browserGet("/", viewer.cookie)).status).toBe(302);
  });

  it("refuses requests for another host", async () => {
    const res = await SELF.fetch("http://evil.example/", { redirect: "manual" });
    expect(res.status).toBe(421);
  });
});

describe("settings", () => {
  it("removing a person ends their sessions", async () => {
    const root = await sessionCookie(ROOT);
    const friend = await sessionCookie("viewer");
    const device = await createDevice("friend-laptop");
    await env.DB.prepare("update devices set user_id = ? where id = ?").bind(friend.userId, device.id).run();
    expect((await browserGet("/", friend.cookie)).status).toBe(200);
    const res = await browserPost(`/settings/users/${friend.userId}/remove`, root.cookie, { csrf: root.csrf });
    expect(res.status).toBe(303);
    expect((await browserGet("/", friend.cookie)).status).toBe(302);
    const sessions = await env.DB.prepare("select count(*) as n from sessions where user_id = ?").bind(friend.userId).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const revoked = await env.DB.prepare("select revoked_at, user_id from devices where id = ?").bind(device.id).first<{ revoked_at: string | null; user_id: string | null }>();
    expect(revoked?.revoked_at).toBeTruthy();
    expect(revoked?.user_id).toBeNull();
    expect((await signedJson(device, "POST", "/api/v1/login-links", {})).status).toBe(401);
    const audit = await env.DB.prepare("select actor_id, target_id from audit_events where action = 'user.remove' order by event_at desc limit 1")
      .first<{ actor_id: string; target_id: string }>();
    expect(audit).toEqual({ actor_id: root.userId, target_id: friend.userId });
  });

  it("shows recent audit events without storing invite secrets", async () => {
    const root = await sessionCookie(ROOT);
    const invitePage = await (await browserPost("/settings/invites", root.cookie, { csrf: root.csrf })).text();
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(invitePage)![1]!;
    const row = await env.DB.prepare("select action, actor_id, metadata from audit_events where action = 'invite.create' order by event_at desc limit 1")
      .first<{ action: string; actor_id: string; metadata: string }>();
    expect(row?.actor_id).toBe(root.userId);
    expect(row?.metadata).not.toContain(token);
    const settings = await (await browserGet("/settings", root.cookie)).text();
    expect(settings).toContain("Recent security activity");
    expect(settings).toContain("invite.create");
    expect(settings).not.toContain(token);
  });

  it("lets a user sign out every other browser session", async () => {
    const current = await sessionCookie("viewer");
    const other = await sessionCookie({ userId: current.userId });
    const res = await browserPost("/account/sessions/revoke-others", current.cookie, { csrf: current.csrf });
    expect(res.status).toBe(303);
    expect((await browserGet("/account", current.cookie)).status).toBe(200);
    expect((await browserGet("/account", other.cookie)).status).toBe(302);
  });

  it("lets anyone change their own name", async () => {
    const viewer = await sessionCookie("viewer");
    const res = await browserPost("/account/name", viewer.cookie, { csrf: viewer.csrf, name: "  Aiko   Tanaka " });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("select name from users where id = ?").bind(viewer.userId).first<{ name: string }>();
    expect(row?.name).toBe("Aiko Tanaka");
    expect(await (await browserGet("/account", viewer.cookie)).text()).toContain("Aiko Tanaka");
    expect((await browserPost("/account/name", viewer.cookie, { csrf: viewer.csrf, name: "   " })).status).toBe(400);
    expect((await browserPost("/account/name", viewer.cookie, { csrf: "wrong", name: "x" })).status).toBe(403);
  });

  it("does not let the owner remove themselves", async () => {
    const root = await sessionCookie(ROOT);
    expect((await browserPost(`/settings/users/${root.userId}/remove`, root.cookie, { csrf: root.csrf })).status).toBe(400);
  });

  it("refuses a form from a sandboxed page (Origin: null)", async () => {
    const root = await sessionCookie(ROOT);
    const res = await browserPost("/settings/invites", root.cookie, { csrf: root.csrf }, "null");
    expect(res.status).toBe(403);
  });

  it("refuses a form without the CSRF token", async () => {
    const root = await sessionCookie(ROOT);
    const res = await browserPost("/settings/invites", root.cookie, { csrf: "wrong" });
    expect(res.status).toBe(403);
  });

  it("removes external access and restores from the trash", async () => {
    const device = await createDevice();
    const { body } = await publish(device, { "index.html": "x" }, { allow_connect: ["api.example.com"] });
    const root = await sessionCookie(ROOT);
    expect(await (await browserGet("/settings", root.cookie)).text()).toContain("api.example.com");
    await browserPost(`/settings/connect/${body.id}/revoke`, root.cookie, { csrf: root.csrf });
    const v = await env.DB.prepare("select allow_connect from versions where artifact_id = ?").bind(body.id).first<{ allow_connect: string | null }>();
    expect(v?.allow_connect).toBeNull();

    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?").bind(new Date().toISOString(), body.id).run();
    await browserPost(`/settings/trash/${body.id}/restore`, root.cookie, { csrf: root.csrf });
    expect((await browserGet(`/a/${body.id}`, root.cookie)).status).toBe(200);
  });
});

describe("device pairing", () => {
  async function startPairing() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const res = await SELF.fetch(`${ORIGIN}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "codex-laptop", public_key: base64url(raw) }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; approve_url: string };
  }

  async function poll(code: string) {
    return (await (await SELF.fetch(`${ORIGIN}/api/v1/devices/pair/${code}`)).json()) as { status: string; device_id?: string };
  }

  it("registers the key once root approves", async () => {
    const { code, approve_url } = await startPairing();
    expect(approve_url).toBe(`${ORIGIN}/pair/${code}`);
    expect((await poll(code)).status).toBe("pending");

    const root = await sessionCookie(ROOT);
    const page = await (await browserGet(`/pair/${code}`, root.cookie)).text();
    expect(page).toContain(code);
    expect(page).toContain("codex-laptop");

    await browserPost(`/pair/${code}`, root.cookie, { csrf: root.csrf, decision: "approve" });
    const result = await poll(code);
    expect(result.status).toBe("approved");
    const device = await env.DB.prepare("select name from devices where id = ?").bind(result.device_id!).first<{ name: string }>();
    expect(device?.name).toBe("codex-laptop");
  });

  it("creates only one device when approval requests race", async () => {
    const { code } = await startPairing();
    const root = await sessionCookie(ROOT);
    await Promise.all([
      browserPost(`/pair/${code}`, root.cookie, { csrf: root.csrf, decision: "approve" }),
      browserPost(`/pair/${code}`, root.cookie, { csrf: root.csrf, decision: "approve" }),
    ]);
    const pairing = await env.DB.prepare("select device_id from pairings where code = ?").bind(code).first<{ device_id: string }>();
    const devices = await env.DB.prepare("select count(*) as n from devices where public_key = (select public_key from pairings where code = ?)")
      .bind(code)
      .first<{ n: number }>();
    expect(pairing?.device_id).toBeTruthy();
    expect(devices?.n).toBe(1);
  });

  it("does not let a viewer approve", async () => {
    const { code } = await startPairing();
    const viewer = await sessionCookie("viewer");
    const res = await browserPost(`/pair/${code}`, viewer.cookie, { csrf: viewer.csrf, decision: "approve" });
    expect(res.status).toBe(403);
    expect((await poll(code)).status).toBe("pending");
  });

  it("reports a denied request", async () => {
    const { code } = await startPairing();
    const root = await sessionCookie(ROOT);
    await browserPost(`/pair/${code}`, root.cookie, { csrf: root.csrf, decision: "deny" });
    expect((await poll(code)).status).toBe("denied");
    expect(await (await browserGet(`/pair/${code}`, root.cookie)).text()).toContain("This request was denied");
  });

  it("says the device was approved when the approval page is reloaded", async () => {
    const { code } = await startPairing();
    const root = await sessionCookie(ROOT);
    await browserPost(`/pair/${code}`, root.cookie, { csrf: root.csrf, decision: "approve" });
    const reload = await browserGet(`/pair/${code}`, root.cookie);
    expect(reload.status).toBe(200);
    const html = await reload.text();
    expect(html).toContain("codex-laptop can publish");
    expect(html).not.toContain("Approve</button>");
  });

  it("says an unknown code has expired", async () => {
    const root = await sessionCookie(ROOT);
    const res = await browserGet("/pair/ZZZZ-ZZZZ", root.cookie);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("expired");
  });

  it("limits how many requests from one address can wait for approval", async () => {
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare("insert into pairings (code, name, public_key, requested_ip, expires_at) values (?, 'x', 'x', 'unknown', ?)")
        .bind(`FILL-${i}`, new Date(Date.now() + 60_000).toISOString())
        .run();
    }
    const res = await SELF.fetch(`${ORIGIN}/api/v1/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", public_key: "a".repeat(43) }),
    });
    expect(res.status).toBe(429);
  });
});
