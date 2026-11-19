import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { browserGet, browserPost, createDevice, publish, sessionCookie, signedJson } from "./helpers.ts";

const PAGE = { "index.html": "<p>hi</p>" };

async function inbox(userId: string): Promise<{ kind: string; reason: string; artifact_id: string; read_at: string | null }[]> {
  const { results } = await env.DB.prepare(
    "select v.kind, n.reason, v.artifact_id, n.read_at from notifications n join activity v on v.id = n.activity_id where n.user_id = ? order by n.created_at",
  )
    .bind(userId)
    .all<{ kind: string; reason: string; artifact_id: string; read_at: string | null }>();
  return results;
}

describe("activity and notifications", () => {
  it("tells the people watching a page about its changes, not the one who made them, and counts them on the bell", async () => {
    const device = await createDevice("laptop");
    const page = await publish(device, PAGE, { title: "Watched page" });
    const alice = await sessionCookie("viewer");
    expect((await browserPost("/watch", alice.cookie, { csrf: alice.csrf, page: page.body.id })).status).toBe(303);
    await publish(device, PAGE, { id: page.body.id, title: "Watched page" });
    expect(await inbox(alice.userId)).toEqual([expect.objectContaining({ kind: "updated", reason: "watching", artifact_id: page.body.id })]);
    const home = await (await browserGet("/", alice.cookie)).text();
    expect(home).toContain('class="bell-count">1<');
    // Her own comment does not come back to her; it makes her watch the page anyway.
    await browserPost(`/a/${page.body.id}/comments`, alice.cookie, { csrf: alice.csrf, body: "Looks good" });
    expect((await inbox(alice.userId)).length).toBe(1);
  });

  it("tells whoever a comment names, and the people in a thread about replies, if they may see the page", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "Mentioned", title: "Plan" });
    const owner = await sessionCookie("root");
    const bob = await sessionCookie({ userId: await namedUser("Bob Tanaka") });
    const carol = await sessionCookie({ userId: await namedUser("Carol Ito") });
    const res = await browserPost(`/a/${page.body.id}/comments`, owner.cookie, { csrf: owner.csrf, body: "@Bob Tanaka and @Carol Ito, please look", mentions: `${bob.userId},${carol.userId}` });
    expect(res.status).toBe(303);
    expect((await inbox(bob.userId)).map((n) => n.reason)).toEqual(["mentioned"]);
    // Once the project is members only, Carol (not a member) is no longer told.
    await browserPost("/projects/Mentioned", owner.cookie, { csrf: owner.csrf, access: "members" });
    await browserPost("/projects/Mentioned/members", owner.cookie, { csrf: owner.csrf, user: bob.userId, role: "viewer" });
    const thread = (await env.DB.prepare("select id from comments where artifact_id = ? and reply_to is null").bind(page.body.id).first<{ id: string }>())!.id;
    await browserPost(`/a/${page.body.id}/comments`, owner.cookie, { csrf: owner.csrf, body: "@Carol Ito ping", mentions: carol.userId });
    expect((await inbox(carol.userId)).length).toBe(1);
    // Bob replies; the owner, who started the thread, hears about it.
    await browserPost(`/a/${page.body.id}/comments`, bob.cookie, { csrf: bob.csrf, body: "Done", reply_to: thread });
    expect((await inbox(owner.userId)).map((n) => [n.kind, n.reason])).toContainEqual(["replied", "thread"]);
    // An agent's reply that resolves the thread tells its people too.
    await signedJson(device, "POST", `/api/v1/artifacts/${page.body.id}/comments`, { body: "Fixed", reply_to: thread, resolve: true });
    expect((await inbox(bob.userId)).map((n) => n.kind)).toEqual(expect.arrayContaining(["replied", "resolved"]));
  });

  it("lists, opens and clears notifications, and shows activity only on pages one may see", async () => {
    const device = await createDevice();
    const open = await publish(device, PAGE, { project: "FeedOpen", title: "Open news" });
    const shut = await publish(device, PAGE, { project: "FeedShut", title: "Shut news" });
    const owner = await sessionCookie("root");
    await browserPost("/projects/FeedShut", owner.cookie, { csrf: owner.csrf, access: "members" });
    const dave = await sessionCookie("viewer");
    await browserPost("/watch", dave.cookie, { csrf: dave.csrf, project: "FeedOpen" });
    await publish(device, PAGE, { project: "FeedOpen", title: "Second open page" });
    const list = await (await browserGet("/notifications", dave.cookie)).text();
    expect(list).toContain("Second open page");
    const nid = /\/notifications\/([0-9a-z]{16})\/open/.exec(list)![1];
    const opened = await browserGet(`/notifications/${nid}/open`, dave.cookie);
    expect(opened.status).toBe(303);
    expect((await inbox(dave.userId))[0]!.read_at).not.toBeNull();
    const feed = await (await browserGet("/activity", dave.cookie)).text();
    expect(feed).toContain(`/a/${open.body.id}`);
    expect(feed).not.toContain(`/a/${shut.body.id}`);
    expect((await (await browserGet("/?project=FeedOpen", dave.cookie)).text())).toContain("Recent activity");
    await browserPost("/notifications/read", dave.cookie, { csrf: dave.csrf });
    expect((await inbox(dave.userId)).every((n) => n.read_at)).toBe(true);
  });
});

async function namedUser(name: string): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 21);
  await env.DB.prepare("insert into users (id, name, role, created_at) values (?, ?, 'viewer', ?)").bind(id, name, new Date().toISOString()).run();
  return id;
}
