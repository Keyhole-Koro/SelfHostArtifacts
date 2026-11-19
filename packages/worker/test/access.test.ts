import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, browserPost, contentSrc, createDevice, publish, sessionCookie, signedFetch, type TestDevice } from "./helpers.ts";
import type { MacroData } from "../src/macros.ts";

type Who = { cookie: string; csrf: string; userId: string };
const PAGE = { "index.html": "<p>plan</p>" };

/** A project with an editor and a reader, a parent page and a child under it. */
async function setup(name: string) {
  const device = await createDevice();
  const owner = await sessionCookie("root");
  const editor = await sessionCookie("viewer");
  const other = await sessionCookie("viewer");
  const reader = await sessionCookie("viewer");
  const parent = (await publish(device, PAGE, { project: name, title: `${name} salaries`, text: "salary bands" })).body.id as string;
  const child = (await publish(device, PAGE, { parent, title: `${name} details`, text: "salary details" })).body.id as string;
  for (const who of [editor, other]) await browserPost(`/projects/${name}/members`, owner.cookie, { csrf: owner.csrf, user: who.userId, role: "editor" });
  return { device, owner, editor, other, reader, parent, child };
}

const sees = async (who: Who, id: string) => (await browserGet(`/a/${id}`, who.cookie)).status === 200;

describe("page restrictions", () => {
  it("hide a page and the pages under it from everyone not listed, everywhere", async () => {
    const { device, owner, editor, reader, other, parent, child } = await setup("Hush");
    expect((await browserPost(`/a/${parent}/access`, editor.cookie, { csrf: editor.csrf, restriction: "view" })).status).toBe(303);
    await browserPost(`/a/${parent}/access/people`, editor.cookie, { csrf: editor.csrf, user: reader.userId, can: "view" });
    // The one who restricted it, the owner and the person let in see both pages; the other editor neither.
    for (const who of [editor, owner, reader]) expect([await sees(who, parent), await sees(who, child)]).toEqual([true, true]);
    expect([await sees(other, parent), await sees(other, child)]).toEqual([false, false]);
    expect((await browserGet(`/a/${child}/token`, other.cookie)).status).toBe(404);
    // Nor in the list, the tree, search, a label's pages or the activity.
    const list = await (await browserGet("/?project=Hush", other.cookie)).text();
    expect(list).not.toContain(`/a/${parent}`);
    expect(list).not.toContain(`/a/${child}`);
    const all = await (await browserGet("/", other.cookie)).text();
    expect(all).not.toContain("Hush salaries");
    expect(await (await browserGet(`/search?q=salary`, other.cookie)).text()).not.toContain("Hush");
    expect(await (await browserGet("/activity", other.cookie)).text()).not.toContain("Hush");
    expect(await (await browserGet(`/search?q=salary`, reader.cookie)).text()).toContain("Hush salaries");
    // A page that lists its project's pages leaves them out for him.
    const hub = await publish(device, { "index.md": "# Hub\n\n{{recent}}\n" }, { entry: "index.md", project: "Hush", title: "Hub" });
    const res = await SELF.fetch(`${ORIGIN}${(await contentSrc(hub.body.id, other.cookie)).replace(/doc\.html$/, "macros.json")}`);
    expect(((await res.json()) as MacroData).recent?.map((p) => p.title)).toEqual(["Hub"]);
    // Agents act for the owner and still see the page.
    expect((await signedFetch(device, "GET", `/api/v1/artifacts/${child}`)).status).toBe(200);
  });

  it("let everyone view but only the listed people change a page", async () => {
    const { owner, editor, other, parent, child } = await setup("Frozen");
    await browserPost(`/a/${parent}/access`, owner.cookie, { csrf: owner.csrf, restriction: "edit" });
    await browserPost(`/a/${parent}/access/people`, owner.cookie, { csrf: owner.csrf, user: editor.userId, can: "edit" });
    expect(await sees(other, child)).toBe(true);
    expect((await browserPost(`/a/${child}/labels`, other.cookie, { csrf: other.csrf, add: "x" })).status).toBe(403);
    expect((await browserPost(`/a/${child}/labels`, editor.cookie, { csrf: editor.csrf, add: "x" })).status).toBe(303);
    const forOther = await (await browserGet(`/a/${child}`, other.cookie)).text();
    expect(forOther).toMatch(/class="badge public"[^>]*>\s*restricted\s*</);
    // Nobody can lock themselves out, and only people who may see the project can be let in.
    expect((await browserPost(`/a/${parent}/access/remove`, editor.cookie, { csrf: editor.csrf, user: editor.userId })).status).toBe(400);
    const outsider = await sessionCookie("viewer");
    await browserPost("/projects/Frozen", owner.cookie, { csrf: owner.csrf, access: "members" });
    expect((await browserPost(`/a/${parent}/access/people`, owner.cookie, { csrf: owner.csrf, user: outsider.userId, can: "edit" })).status).toBe(400);
    // A page cannot be put under one its mover may not change.
    const free = (await publish(await createDevice(), PAGE, { project: "Frozen", title: "Free" })).body.id as string;
    expect((await browserPost(`/a/${free}/parent`, other.cookie, { csrf: other.csrf, parent })).status).toBe(403);
    expect((await browserPost("/new", other.cookie, { csrf: other.csrf, parent, title: "Under" })).status).toBe(403);
  });

  it("tell only the people who may see the page", async () => {
    const { device, owner, editor, other, parent, child } = await setup("Quiet");
    for (const who of [editor, other]) await browserPost("/watch", who.cookie, { csrf: who.csrf, project: "Quiet" });
    await browserPost(`/a/${parent}/access`, owner.cookie, { csrf: owner.csrf, restriction: "view" });
    await browserPost(`/a/${parent}/access/people`, owner.cookie, { csrf: owner.csrf, user: editor.userId, can: "edit" });
    await publish(device, PAGE, { id: child, title: "Quiet details" });
    const told = async (who: Who) =>
      (await env.DB.prepare("select count(*) as n from notifications n join activity v on v.id = n.activity_id where n.user_id = ? and v.artifact_id = ?").bind(who.userId, child).first<{ n: number }>())!.n;
    expect(await told(editor)).toBe(1);
    expect(await told(other)).toBe(0);
    // The comment box suggests only the people who may see it.
    const page = await (await browserGet(`/a/${child}`, editor.cookie)).text();
    const people = JSON.parse(/const people = (\[.*?\]);/.exec(page)![1]!) as { id: string }[];
    expect(people.map((p) => p.id)).toContain(editor.userId);
    expect(people.map((p) => p.id)).not.toContain(other.userId);
  });

  it("stay on the pages under a restricted page when it goes to the trash", async () => {
    const { device, owner, editor, other, parent, child } = await setup("Kept");
    await browserPost(`/a/${parent}/access`, owner.cookie, { csrf: owner.csrf, restriction: "view" });
    await browserPost(`/a/${parent}/access/people`, owner.cookie, { csrf: owner.csrf, user: editor.userId, can: "view" });
    expect((await signedFetch(device as TestDevice, "DELETE", `/api/v1/artifacts/${parent}`)).status).toBe(200);
    expect(await sees(other, child)).toBe(false);
    expect(await sees(editor, child)).toBe(true);
    const row = await env.DB.prepare("select restriction from artifacts where id = ?").bind(child).first<{ restriction: string }>();
    expect(row!.restriction).toBe("view");
    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${child}`)).json()) as { restriction: string; parent: string | null };
    expect(detail).toMatchObject({ restriction: "view", parent: null });
  });
});
