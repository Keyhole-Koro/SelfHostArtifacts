import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, contentSrc, createDevice, publish, sessionCookie, signedFetch } from "./helpers.ts";

type Who = { cookie: string; csrf: string; userId: string };

const save = (id: string, who: Who, body: unknown) =>
  SELF.fetch(`${ORIGIN}/a/${id}/edit`, {
    method: "POST",
    headers: { cookie: who.cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf": who.csrf },
    body: JSON.stringify(body),
  });

const HTML = '<!doctype html><html><head><title>Status</title><link rel="stylesheet" href="style.css"></head><body><h1>Status</h1>\n<p>All good</p>\n<p>Footer</p>\n</body></html>';

async function page() {
  const device = await createDevice();
  const other = await publish(device, { "index.html": "<p>x</p>" }, { title: "Other" });
  const made = await publish(device, { "index.html": HTML, "style.css": "h1 { color: red; }", "logo.png": "PNG" }, { title: "Status" });
  const read = async (path: string) => (await signedFetch(device, "GET", `/api/v1/artifacts/${made.body.id}/files/${path}`)).text();
  return { device, id: made.body.id as string, other: other.body.id as string, read };
}

describe("changing an HTML page's source in the browser", () => {
  it("opens the source editor with the page's text files, read without the viewer's script", async () => {
    const { id } = await page();
    const owner = await sessionCookie("root");
    const edit = await (await browserGet(`/a/${id}/edit`, owner.cookie)).text();
    expect(edit).toContain("!artifact/source.html");
    expect(edit).toContain('<option value="style.css">style.css</option>');
    expect(edit).not.toContain("logo.png");
    const root = (await contentSrc(id, owner.cookie)).replace(/index\.html$/, "");
    const source = await (await SELF.fetch(`${ORIGIN}${root}!artifact/source.html`)).text();
    expect(source).toContain('data-files="[&#34;index.html&#34;,&#34;style.css&#34;]"');
    expect(source).toMatch(/codemirror\/5\.65\.21\/codemirror\.min\.js" integrity="sha512-/);
    const raw = await SELF.fetch(`${ORIGIN}${root}!artifact/raw/index.html`);
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await raw.text()).toBe(HTML);
    expect((await SELF.fetch(`${ORIGIN}${root}!artifact/raw/logo.png`)).status).toBe(404);
    expect(await (await browserGet(`/a/${id}`, owner.cookie)).text()).toContain("Edit source");
  });

  it("saves the changed files as a new version, with the text and links read again", async () => {
    const { id, other, read } = await page();
    const owner = await sessionCookie("root");
    const changed = HTML.replace("All good", `Degraded, see <a href="/a/${other}">the other page</a>`);
    const res = await save(id, owner, { base_version: 1, title: "Status now", files: { "index.html": changed }, merge: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2, merged: false });
    expect(await read("index.html")).toBe(changed);
    expect(await read("style.css")).toBe("h1 { color: red; }");
    expect(await read("logo.png")).toBe("PNG");
    const text = (await (await browserGet(`/a/${id}/text?v=2`, owner.cookie)).json()) as { text: string };
    expect(text.text).toContain("Degraded, see the other page");
    const links = (await (await signedFetch(await createDevice(), "GET", `/api/v1/artifacts/${other}`)).json()) as { linked_from: { id: string }[] };
    expect(links.linked_from.map((l) => l.id)).toContain(id);
    // Only its text files can be changed, and only by those who may change the page.
    expect((await save(id, owner, { base_version: 2, title: "x", files: { "logo.png": "GIF" } })).status).toBe(400);
    const reader = await sessionCookie("viewer");
    expect((await save(id, reader, { base_version: 2, title: "x", files: { "index.html": "<p>mine</p>" } })).status).toBe(403);
  });

  it("merges changes saved meanwhile, and marks the lines both changed", async () => {
    const { id, read } = await page();
    const owner = await sessionCookie("root");
    // One saves the style, the other (from v1) the page: both kept.
    await save(id, owner, { base_version: 1, title: "Status", files: { "style.css": "h1 { color: blue; }" }, merge: true });
    const clean = await save(id, owner, { base_version: 1, title: "Status", files: { "index.html": HTML.replace("Footer", "Footer, v2") }, merge: true });
    expect(await clean.json()).toEqual({ version: 3, merged: true });
    expect(await read("style.css")).toBe("h1 { color: blue; }");
    expect(await read("index.html")).toContain("Footer, v2");
    // Both change the same line of the page.
    await save(id, owner, { base_version: 3, title: "Status", files: { "index.html": (await read("index.html")).replace("All good", "Theirs") }, merge: true });
    const clash = await save(id, owner, { base_version: 3, title: "Status", files: { "index.html": HTML.replace("Footer", "Footer, v2").replace("All good", "Mine") }, merge: true });
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { merged_files: Record<string, string>; conflicts: number };
    expect(body.conflicts).toBe(1);
    expect(body.merged_files["index.html"]).toContain("<<<<<<< your text\n<p>Mine</p>\n=======\n<p>Theirs</p>\n>>>>>>> v4 by Owner");
  });
});
