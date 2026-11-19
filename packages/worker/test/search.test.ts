import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, browserPost, contentSrc, createDevice, publish, sessionCookie, signedFetch } from "./helpers.ts";

const PAGE = { "index.html": "<p>hi</p>" };

async function search(q: string): Promise<{ id: string; title: string; snippet: string }[]> {
  const res = await signedFetch(await createDevice(), "GET", `/api/v1/search?q=${encodeURIComponent(q)}`);
  return ((await res.json()) as { results: { id: string; title: string; snippet: string }[] }).results;
}

describe("search", () => {
  it("finds a page by any part of its text, Japanese included, and marks the match", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "IPC notes", text: "要求の列は 1 本だけ\nThe ring holds thirty-two slots" });
    expect((await search("thirty-two")).map((h) => h.id)).toContain(page.body.id);
    const ja = await search("要求の列");
    expect(ja.map((h) => h.id)).toContain(page.body.id);
    expect(ja.find((h) => h.id === page.body.id)!.snippet).toContain("[[要求の列]]");
    // Under three characters the trigram index cannot help; a scan still finds it.
    expect((await search("要求")).map((h) => h.id)).toContain(page.body.id);
    expect((await search("thirty-two 要求の列")).map((h) => h.id)).toContain(page.body.id);
    expect((await search("thirty-two nowhere-else")).map((h) => h.id)).not.toContain(page.body.id);
  });

  it("follows the current version, keeps the text when an older CLI sends none, and drops pages in the trash", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "Changing", text: "first wording" });
    await publish(device, PAGE, { id: page.body.id, title: "Changing", text: "second wording" });
    expect((await search("first wording")).map((h) => h.id)).not.toContain(page.body.id);
    expect((await search("second wording")).map((h) => h.id)).toContain(page.body.id);
    await publish(device, PAGE, { id: page.body.id, title: "Renamed page" });
    expect((await search("second wording")).map((h) => h.id)).toContain(page.body.id);
    expect((await search("Renamed page")).map((h) => h.id)).toContain(page.body.id);
    await signedFetch(device, "DELETE", `/api/v1/artifacts/${page.body.id}`);
    expect((await search("second wording")).map((h) => h.id)).not.toContain(page.body.id);
  });

  it("shows a viewer only the pages they may see, with the matches marked and the rest escaped", async () => {
    const device = await createDevice();
    const open = await publish(device, PAGE, { title: "Open page", text: "<b>sesame</b> for everyone" });
    const shut = await publish(device, PAGE, { title: "Shut page", project: "SearchShut", text: "sesame for members" });
    const owner = await sessionCookie("root");
    await browserPost("/projects/SearchShut", owner.cookie, { csrf: owner.csrf, access: "members" });
    const viewer = await sessionCookie("viewer");
    const html = await (await browserGet("/search?q=sesame", viewer.cookie)).text();
    expect(html).toContain(`/a/${open.body.id}`);
    expect(html).not.toContain(`/a/${shut.body.id}`);
    expect(html).toContain("&#60;b&#62;<mark>sesame</mark>");
    expect(await (await browserGet("/search?q=sesame", owner.cookie)).text()).toContain(`/a/${shut.body.id}`);
  });
});

describe("links between pages", () => {
  it("records what a page links to, and shows each page what links to it", async () => {
    const device = await createDevice();
    const target = await publish(device, PAGE, { title: "Target" });
    const source = await publish(device, PAGE, { title: "Source", links: [target.body.id] });
    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${target.body.id}`)).json()) as { linked_from: { id: string; title: string }[] };
    expect(detail.linked_from).toEqual([expect.objectContaining({ id: source.body.id, title: "Source" })]);
    const { cookie } = await sessionCookie("viewer");
    const html = await (await browserGet(`/a/${target.body.id}`, cookie)).text();
    expect(html).toContain("Linked from");
    expect(html).toContain(`href="/a/${source.body.id}"`);
    // A new version that no longer links there takes the link away.
    await publish(device, PAGE, { id: source.body.id, title: "Source", links: [] });
    const after = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${target.body.id}`)).json()) as { linked_from: unknown[] };
    expect(after.linked_from).toEqual([]);
  });

  it("appends the link script to HTML opened in the viewer, and not to public links or other files", async () => {
    const device = await createDevice();
    const page = await publish(device, { "index.html": "<p>hi</p>", "data.json": "{}" }, { title: "Nav" });
    const { cookie } = await sessionCookie("root");
    const src = await contentSrc(page.body.id, cookie);
    const res = await SELF.fetch(`${ORIGIN}${src}`);
    const body = await res.text();
    expect(body.startsWith("<p>hi</p>")).toBe(true);
    expect(body).toContain(`<script src="${src.replace(/index\.html$/, "")}!artifact/nav.js"></script>`);
    expect(Number(res.headers.get("content-length"))).toBe(new TextEncoder().encode(body).length);
    const nav = await SELF.fetch(`${ORIGIN}${src.replace(/index\.html$/, "")}!artifact/nav.js`);
    expect(nav.status).toBe(200);
    expect(await nav.text()).toContain("artifact:navigate");
    expect(await (await SELF.fetch(`${ORIGIN}${src.replace(/index\.html$/, "data.json")}`)).text()).toBe("{}");
  });
});

describe("comparing versions", () => {
  it("hands out each version's text to those who may see the page", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "Versions", project: "CompareShut", text: "one\ntwo" });
    await publish(device, PAGE, { id: page.body.id, title: "Versions", text: "one\nthree" });
    const owner = await sessionCookie("root");
    expect(await (await browserGet(`/a/${page.body.id}/text?v=1`, owner.cookie)).json()).toEqual({ version: 1, text: "one\ntwo" });
    expect((await browserGet(`/a/${page.body.id}/diff?from=1&to=2`, owner.cookie)).status).toBe(200);
    await browserPost("/projects/CompareShut", owner.cookie, { csrf: owner.csrf, access: "members" });
    const stranger = await sessionCookie("viewer");
    expect((await browserGet(`/a/${page.body.id}/text?v=1`, stranger.cookie)).status).toBe(404);
    expect((await browserGet(`/a/${page.body.id}/diff`, stranger.cookie)).status).toBe(404);
  });
});
