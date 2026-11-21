import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { browserGet, browserPost, createDevice, publish, sessionCookie, signedFetch, signedJson } from "./helpers.ts";

const PAGE = { "index.html": "<p>hi</p>" };

interface Summary { id: string; project: string | null; parent: string | null; position: number }

async function detail(id: string): Promise<Summary> {
  const res = await signedFetch(await createDevice(), "GET", `/api/v1/artifacts/${id}`);
  return (await res.json()) as Summary;
}

describe("the page tree in a project", () => {
  it("puts a new page under its parent, in the parent's project, after the siblings", async () => {
    const device = await createDevice();
    const top = await publish(device, PAGE, { project: "TreeA", title: "Top" });
    const first = await publish(device, PAGE, { parent: top.body.id, title: "First" });
    const second = await publish(device, PAGE, { parent: top.body.id, title: "Second" });
    expect(first.status).toBe(201);
    expect(await detail(first.body.id)).toMatchObject({ project: "TreeA", parent: top.body.id, position: 1 });
    expect(await detail(second.body.id)).toMatchObject({ project: "TreeA", parent: top.body.id, position: 2 });
  });

  it("refuses a parent in another project, a missing one, and the page itself or a page below it", async () => {
    const device = await createDevice();
    const a = await publish(device, PAGE, { project: "TreeB" });
    const b = await publish(device, PAGE, { project: "TreeC" });
    expect((await publish(device, PAGE, { project: "TreeC", parent: a.body.id })).status).toBe(400);
    expect((await publish(device, PAGE, { parent: "0000000000000000" })).status).toBe(400);
    const child = await publish(device, PAGE, { parent: b.body.id });
    const loop = await signedJson(device, "PATCH", `/api/v1/artifacts/${b.body.id}`, { parent: child.body.id });
    expect(loop.status).toBe(400);
    expect((await signedJson(device, "PATCH", `/api/v1/artifacts/${b.body.id}`, { parent: b.body.id })).status).toBe(400);
  });

  it("moves a page under another one and to a place among its siblings", async () => {
    const device = await createDevice();
    const top = await publish(device, PAGE, { project: "TreeD" });
    const [x, y, z] = [await publish(device, PAGE, { parent: top.body.id }), await publish(device, PAGE, { parent: top.body.id }), await publish(device, PAGE, { project: "TreeD" })];
    const moved = await signedJson(device, "PATCH", `/api/v1/artifacts/${z.body.id}`, { parent: top.body.id, position: 1 });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ parent: top.body.id, position: 1 });
    expect((await detail(x.body.id)).position).toBe(2);
    expect((await detail(y.body.id)).position).toBe(3);
  });

  it("takes the pages under a page along to another project, and lifts them up when it goes to the trash", async () => {
    const device = await createDevice();
    const top = await publish(device, PAGE, { project: "TreeE" });
    const mid = await publish(device, PAGE, { parent: top.body.id });
    const leaf = await publish(device, PAGE, { parent: mid.body.id });
    await signedJson(device, "PATCH", `/api/v1/artifacts/${mid.body.id}`, { project: "TreeF" });
    expect(await detail(mid.body.id)).toMatchObject({ project: "TreeF", parent: null });
    expect(await detail(leaf.body.id)).toMatchObject({ project: "TreeF", parent: mid.body.id });
    expect((await signedFetch(device, "DELETE", `/api/v1/artifacts/${mid.body.id}`)).status).toBe(200);
    expect(await detail(leaf.body.id)).toMatchObject({ project: "TreeF", parent: null });
  });

  it("shows a project as its tree, and a page with the trail above it and its project's pages beside it", async () => {
    const device = await createDevice();
    const top = await publish(device, PAGE, { project: "TreeG", title: "Handbook" });
    const child = await publish(device, PAGE, { parent: top.body.id, title: "Chapter one" });
    const { cookie } = await sessionCookie("viewer");
    const list = await (await browserGet("/?project=TreeG", cookie)).text();
    expect(list).toContain('class="tree"');
    expect(list.indexOf("Handbook")).toBeLessThan(list.indexOf("Chapter one"));
    const page = await (await browserGet(`/a/${child.body.id}`, cookie)).text();
    expect(page).toContain(`<a href="/a/${top.body.id}" title="Handbook">Handbook</a>`);
    expect(page).toContain('id="side"');
    expect(page).toContain('aria-current="page"');
  });

  it("lets the owner move a page from the browser", async () => {
    const device = await createDevice();
    const a = await publish(device, PAGE, { project: "TreeH" });
    const b = await publish(device, PAGE, { project: "TreeH" });
    const { cookie, csrf } = await sessionCookie("root");
    expect((await browserPost(`/a/${b.body.id}/parent`, cookie, { csrf, parent: a.body.id })).status).toBe(303);
    expect((await detail(b.body.id)).parent).toBe(a.body.id);
    expect((await browserPost(`/a/${a.body.id}/parent`, cookie, { csrf, parent: b.body.id })).status).toBe(400);
    const viewer = await sessionCookie("viewer");
    expect((await browserPost(`/a/${b.body.id}/parent`, viewer.cookie, { csrf: viewer.csrf, parent: "" })).status).not.toBe(303);
  });
});

describe("who rearranges a project", () => {
  it("lets the project's editors move its pages, and not its viewers or the editors of another project", async () => {
    const device = await createDevice();
    const a = await publish(device, PAGE, { project: "Edited" });
    const b = await publish(device, PAGE, { project: "Edited" });
    await publish(device, PAGE, { project: "Elsewhere" });
    const owner = await sessionCookie("root");
    const editor = await sessionCookie("viewer");
    const reader = await sessionCookie("viewer");
    const outsider = await sessionCookie("viewer");
    for (const [space, who, role] of [["Edited", editor, "editor"], ["Edited", reader, "viewer"], ["Elsewhere", outsider, "editor"]] as const) {
      expect((await browserPost(`/projects/${space}/members`, owner.cookie, { csrf: owner.csrf, user: who.userId, role })).status).toBe(303);
    }
    expect((await browserPost(`/a/${b.body.id}/parent`, reader.cookie, { csrf: reader.csrf, parent: a.body.id })).status).toBe(403);
    expect((await browserPost(`/a/${b.body.id}/parent`, outsider.cookie, { csrf: outsider.csrf, parent: a.body.id })).status).toBe(403);
    expect((await browserPost(`/a/${b.body.id}/parent`, editor.cookie, { csrf: editor.csrf, parent: a.body.id })).status).toBe(303);
    expect((await detail(b.body.id)).parent).toBe(a.body.id);
    // An editor moves pages within the project; another project is the owner's call.
    expect((await browserPost(`/a/${b.body.id}/project`, editor.cookie, { csrf: editor.csrf, project: "Elsewhere" })).status).not.toBe(303);
    const html = await (await browserGet(`/a/${b.body.id}`, editor.cookie)).text();
    expect(html).toContain(`action="/a/${b.body.id}/parent"`);
    expect(html).not.toContain(`action="/a/${b.body.id}/project"`);
  });
});

describe("who sees a project", () => {
  it("keeps a members-only project from viewers who are not members, and shows it to members and the owner", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "Secretive", title: "Plans" });
    const owner = await sessionCookie("root");
    const member = await sessionCookie("viewer");
    const stranger = await sessionCookie("viewer");

    expect((await browserPost("/projects/Secretive", owner.cookie, { csrf: owner.csrf, description: "Not for all", access: "members" })).status).toBe(303);
    expect((await browserPost("/projects/Secretive/members", owner.cookie, { csrf: owner.csrf, user: member.userId, role: "viewer" })).status).toBe(303);

    for (const who of [owner, member]) {
      expect((await browserGet(`/a/${page.body.id}`, who.cookie)).status).toBe(200);
      expect((await browserGet(`/a/${page.body.id}/token`, who.cookie)).status).toBe(200);
      expect(await (await browserGet("/", who.cookie)).text()).toContain("Plans");
    }
    expect((await browserGet(`/a/${page.body.id}`, stranger.cookie)).status).toBe(404);
    expect((await browserGet(`/a/${page.body.id}/token`, stranger.cookie)).status).toBe(404);
    const list = await (await browserGet("/", stranger.cookie)).text();
    expect(list).not.toContain("Plans");
    expect(list).not.toContain("Secretive");
    expect(await (await browserGet("/?project=Secretive", stranger.cookie)).text()).not.toContain("Plans");

    const row = await env.DB.prepare("select description, access from spaces where name = 'Secretive'").first();
    expect(row).toEqual({ description: "Not for all", access: "members" });
  });

  it("lets only the owner change a project's settings", async () => {
    const device = await createDevice();
    await publish(device, PAGE, { project: "Guarded" });
    const viewer = await sessionCookie("viewer");
    expect((await browserGet("/projects/Guarded", viewer.cookie)).status).not.toBe(200);
    expect((await browserPost("/projects/Guarded", viewer.cookie, { csrf: viewer.csrf, access: "members" })).status).not.toBe(303);
    const owner = await sessionCookie("root");
    expect((await browserGet("/projects/Guarded", owner.cookie)).status).toBe(200);
    expect((await browserPost("/projects/Guarded", owner.cookie, { csrf: owner.csrf, access: "members" }, "https://evil.example")).status).not.toBe(303);
  });
});
