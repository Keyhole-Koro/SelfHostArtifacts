import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { restoreArtifact, trashArtifact } from "../src/db/artifacts.ts";
import { ROOT, browserGet, browserPost, createDevice, publish, sessionCookie } from "./helpers.ts";

async function publishPage(html = "<h1>hello public</h1>") {
  const device = await createDevice();
  const { body } = await publish(device, { "index.html": html, "data.json": '{"ok":true}' }, { title: "Shared page" });
  return { device, id: body.id as string };
}

/** Turns the public link on as the owner and returns its path, read from the viewer page. */
async function share(id: string, owner: { cookie: string; csrf: string }, path = ""): Promise<string> {
  const res = await browserPost(`/a/${id}/share${path}`, owner.cookie, { csrf: owner.csrf });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/a/${id}?share=1`);
  const page = await (await browserGet(`/a/${id}?share=1`, owner.cookie)).text();
  const url = page.match(/value="(http[^"]+\/s\/[^"]+)"/)?.[1];
  expect(url).toBeDefined();
  return new URL(url!).pathname;
}

async function iframeSrc(res: Response): Promise<string> {
  const src = (await res.text()).match(/<iframe id="frame" src="([^"]+)"/)?.[1];
  expect(src).toBeDefined();
  return src!.replaceAll("&amp;", "&");
}

describe("public links", () => {
  it("lets anyone with the link view the latest version without signing in", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const path = await share(id, owner);
    expect(path).toMatch(new RegExp(`^/s/${id}/[A-Za-z0-9_-]{43}$`));

    const res = await browserGet(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const src = await iframeSrc(res);
    const content = await browserGet(src);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("<h1>hello public</h1>");
    // Relative files resolve under the same token.
    expect(await (await browserGet(src.replace(/index\.html$/, "data.json"))).text()).toBe('{"ok":true}');

    const token = await browserGet(`${path}/token`);
    expect(token.status).toBe(200);
    expect(((await token.json()) as { src: string }).src).toMatch(/^\/c\//);
  });

  it("does not show the list, versions or the owner's controls on the public page", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const html = await (await browserGet(await share(id, owner))).text();
    expect(html).not.toContain("Versions");
    expect(html).not.toContain(`/a/${id}`);
    expect(html).not.toContain("Turn off");
  });

  it("refuses a wrong key and an artifact without a link", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    expect((await browserGet(`/s/${id}/${"A".repeat(43)}`)).status).toBe(404);
    const path = await share(id, owner);
    expect((await browserGet(path.slice(0, -2) + "AA")).status).toBe(404);
    expect((await browserGet(`${path}x`)).status).toBe(404);
  });

  it("shows the newest version after a republish", async () => {
    const owner = await sessionCookie(ROOT);
    const { device, id } = await publishPage("<p>v1</p>");
    const path = await share(id, owner);
    await publish(device, { "index.html": "<p>v2</p>" }, { id, base_version: 1 } as never);
    const src = await iframeSrc(await browserGet(path));
    expect(await (await browserGet(src)).text()).toBe("<p>v2</p>");
  });

  it("turning it off closes the page and the content it already handed out", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const path = await share(id, owner);
    const src = await iframeSrc(await browserGet(path));
    expect((await browserPost(`/a/${id}/share/off`, owner.cookie, { csrf: owner.csrf })).status).toBe(303);
    expect((await browserGet(path)).status).toBe(404);
    expect((await browserGet(`${path}/token`)).status).toBe(404);
    expect((await browserGet(src)).status).toBe(403);
    // The owner's own viewer is unaffected.
    expect((await browserGet(`/a/${id}`, owner.cookie)).status).toBe(200);
  });

  it("a new link replaces the old one; extending keeps the URL", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const first = await share(id, owner);
    const extended = await share(id, owner);
    expect(extended).toBe(first);
    const second = await share(id, owner, "/reset");
    expect(second).not.toBe(first);
    expect((await browserGet(first)).status).toBe(404);
    expect((await browserGet(second)).status).toBe(200);
  });

  it("expires after 30 days", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const path = await share(id, owner);
    const row = await env.DB.prepare("select share_expires_at from artifacts where id = ?").bind(id).first<{ share_expires_at: string }>();
    const days = (Date.parse(row!.share_expires_at) - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    await env.DB.prepare("update artifacts set share_expires_at = ? where id = ?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    expect((await browserGet(path)).status).toBe(404);
    // Extending an expired link makes a new URL rather than reviving the old one.
    const again = await share(id, owner);
    expect(again).not.toBe(path);
  });

  it("deleting the artifact turns the link off, and restoring does not reopen it", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const path = await share(id, owner);
    expect(await trashArtifact(env.DB, id)).toBe(true);
    expect((await browserGet(path)).status).toBe(404);
    await restoreArtifact(env.DB, id);
    expect((await browserGet(path)).status).toBe(404);
  });

  it("only the owner, with a passkey session and a same-origin form, can change it", async () => {
    const owner = await sessionCookie(ROOT);
    const viewer = await sessionCookie("viewer");
    const { id } = await publishPage();
    expect((await browserPost(`/a/${id}/share`, viewer.cookie, { csrf: viewer.csrf })).status).toBe(403);
    expect((await browserPost(`/a/${id}/share`, owner.cookie, { csrf: owner.csrf }, "null")).status).toBe(403);
    expect((await browserPost(`/a/${id}/share`, owner.cookie, { csrf: "wrong" })).status).toBe(403);
    await env.DB.prepare("update sessions set session_kind = 'device' where user_id = ?").bind(owner.userId).run();
    expect((await browserPost(`/a/${id}/share`, owner.cookie, { csrf: owner.csrf })).status).toBe(302);
    const row = await env.DB.prepare("select share_nonce from artifacts where id = ?").bind(id).first<{ share_nonce: string | null }>();
    expect(row?.share_nonce).toBeNull();
    // A viewer does not see the Share panel.
    expect(await (await browserGet(`/a/${id}`, viewer.cookie)).text()).not.toContain("Create public link");
  });

  it("records turning links on and off without the key", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    const path = await share(id, owner);
    await browserPost(`/a/${id}/share/off`, owner.cookie, { csrf: owner.csrf });
    const { results } = await env.DB.prepare("select action, metadata from audit_events where target_id = ? order by event_at").bind(id).all<{ action: string; metadata: string | null }>();
    expect(results.map((r) => r.action)).toEqual(expect.arrayContaining(["share.enable", "share.disable"]));
    const key = path.split("/").pop()!;
    for (const r of results) expect(r.metadata ?? "").not.toContain(key);
  });

  it("marks shared artifacts in the list", async () => {
    const owner = await sessionCookie(ROOT);
    const { id } = await publishPage();
    await share(id, owner);
    const list = await (await browserGet("/", owner.cookie)).text();
    expect(list).toMatch(/Shared page<\/a>[\s\S]{0,400}public/);
  });
});
