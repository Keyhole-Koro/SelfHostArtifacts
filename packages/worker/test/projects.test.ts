import { describe, expect, it } from "vitest";
import { browserGet, browserPost, createDevice, publish, sessionCookie, signedFetch, signedJson } from "./helpers.ts";

const PAGE = { "index.html": "<p>hi</p>" };

async function project(id: string): Promise<string | null> {
  const device = await createDevice();
  const res = await signedFetch(device, "GET", `/api/v1/artifacts/${id}`);
  return ((await res.json()) as { project: string | null }).project;
}

describe("projects", () => {
  it("puts a new page in the given project, and an update without one keeps it", async () => {
    const device = await createDevice();
    const created = await publish(device, PAGE, { project: "Alpha" });
    expect(created.status).toBe(201);
    expect(await project(created.body.id)).toBe("Alpha");

    expect((await publish(device, PAGE, { id: created.body.id, title: "Second" })).status).toBe(200);
    expect(await project(created.body.id)).toBe("Alpha");

    expect((await publish(device, PAGE, { id: created.body.id, project: "Beta" })).status).toBe(200);
    expect(await project(created.body.id)).toBe("Beta");

    const none = await publish(device, PAGE);
    expect(await project(none.body.id)).toBeNull();
  });

  it("refuses a project name with a slash, a control character or over 60 characters", async () => {
    const device = await createDevice();
    for (const name of ["a/b", "line\nbreak", "x".repeat(61), "  "]) {
      expect((await publish(device, PAGE, { project: name })).status).toBe(400);
    }
  });

  it("lists one project, the pages without one, and the projects with counts", async () => {
    const device = await createDevice();
    const a1 = await publish(device, PAGE, { project: "ListA", title: "A1" });
    const a2 = await publish(device, PAGE, { project: "ListA", title: "A2" });
    await publish(device, PAGE, { project: "ListB", title: "B1" });
    const loose = await publish(device, PAGE, { title: "Loose" });

    const inA = (await (await signedFetch(device, "GET", "/api/v1/artifacts?project=ListA")).json()) as { artifacts: { id: string; project: string }[] };
    expect(inA.artifacts.map((a) => a.id)).toEqual([a2.body.id, a1.body.id]);
    expect(inA.artifacts.every((a) => a.project === "ListA")).toBe(true);

    const without = (await (await signedFetch(device, "GET", "/api/v1/artifacts?project=")).json()) as { artifacts: { id: string; project: null }[] };
    expect(without.artifacts.map((a) => a.id)).toContain(loose.body.id);
    expect(without.artifacts.every((a) => a.project === null)).toBe(true);

    const { projects } = (await (await signedFetch(device, "GET", "/api/v1/projects")).json()) as { projects: { project: string | null; count: number }[] };
    expect(projects.find((p) => p.project === "ListA")?.count).toBe(2);
    expect(projects.find((p) => p.project === "ListB")?.count).toBe(1);
    expect(projects.find((p) => p.project === null)?.count).toBeGreaterThanOrEqual(1);
  });

  it("moves a page without a new version, and out of any project", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "MoveFrom" });
    const moved = await signedJson(device, "PATCH", `/api/v1/artifacts/${page.body.id}`, { project: "MoveTo" });
    expect(moved.status).toBe(200);
    expect(await project(page.body.id)).toBe("MoveTo");
    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${page.body.id}`)).json()) as { version: number };
    expect(detail.version).toBe(1);

    expect((await signedJson(device, "PATCH", `/api/v1/artifacts/${page.body.id}`, { project: null })).status).toBe(200);
    expect(await project(page.body.id)).toBeNull();
    expect((await signedJson(device, "PATCH", `/api/v1/artifacts/${page.body.id}`, { project: "a/b" })).status).toBe(400);
    expect((await signedJson(device, "PATCH", "/api/v1/artifacts/nosuchpage000000", { project: "X" })).status).toBe(404);
  });

  it("shows project buttons on the list and narrows it", async () => {
    const device = await createDevice();
    await publish(device, PAGE, { project: "Gamma", title: "Gamma page" });
    await publish(device, PAGE, { project: "Delta", title: "Delta page" });
    const owner = await sessionCookie("root");

    const all = await (await browserGet("/", owner.cookie)).text();
    expect(all).toContain('aria-label="Projects"');
    expect(all).toContain('href="/?project=Gamma"');
    expect(all).toContain("Gamma page");
    expect(all).toContain("Delta page");

    const gamma = await (await browserGet("/?project=Gamma", owner.cookie)).text();
    expect(gamma).toContain("Gamma page");
    expect(gamma).not.toContain("Delta page");
    expect(gamma).toContain(" in Gamma, newest first");
    expect(await (await browserGet("/?project=Nothing", owner.cookie)).text()).toContain("No page here.");
  });

  it("lets the owner move a page from its viewer, and not a viewer", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "Epsilon" });
    const owner = await sessionCookie("root");
    const html = await (await browserGet(`/a/${page.body.id}`, owner.cookie)).text();
    expect(html).toContain(`action="/a/${page.body.id}/project"`);
    expect(html).toContain('href="/?project=Epsilon"');

    const res = await browserPost(`/a/${page.body.id}/project`, owner.cookie, { csrf: owner.csrf, project: "Zeta" });
    expect(res.status).toBe(303);
    expect(await project(page.body.id)).toBe("Zeta");
    expect((await browserPost(`/a/${page.body.id}/project`, owner.cookie, { csrf: owner.csrf, project: "" })).status).toBe(303);
    expect(await project(page.body.id)).toBeNull();
    expect((await browserPost(`/a/${page.body.id}/project`, owner.cookie, { csrf: owner.csrf, project: "a/b" })).status).toBe(400);

    const viewer = await sessionCookie("viewer");
    expect(await (await browserGet(`/a/${page.body.id}`, viewer.cookie)).text()).not.toContain("/project\"");
    expect((await browserPost(`/a/${page.body.id}/project`, viewer.cookie, { csrf: viewer.csrf, project: "Eta" })).status).toBe(403);
  });
});
