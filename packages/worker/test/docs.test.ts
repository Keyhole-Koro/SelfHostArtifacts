import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, browserPost, contentSrc, createDevice, publish, sessionCookie, signedFetch } from "./helpers.ts";

async function newPage(cookie: string, csrf: string, fields: Record<string, string>): Promise<{ status: number; id?: string }> {
  const res = await browserPost("/new", cookie, { csrf, ...fields });
  const id = /\/a\/([0-9a-z]{16})\/edit$/.exec(res.headers.get("location") ?? "")?.[1];
  return { status: res.status, id };
}

function save(id: string, who: { cookie: string; csrf: string }, body: unknown, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/a/${id}/edit`, {
    method: "POST",
    headers: { cookie: who.cookie, origin, "content-type": "application/json", "x-csrf": who.csrf },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function file(id: string, path: string): Promise<string> {
  return (await signedFetch(await createDevice(), "GET", `/api/v1/artifacts/${id}/files/${path}`)).text();
}

describe("pages written in the browser", () => {
  it("writes a new Markdown page in a project, saves it as a new version, and keeps its text and links", async () => {
    const device = await createDevice();
    const other = await publish(device, { "index.html": "<p>x</p>" }, { project: "Written", title: "Other" });
    const owner = await sessionCookie("root");
    const created = await newPage(owner.cookie, owner.csrf, { project: "Written", title: "Meeting notes" });
    expect(created.status).toBe(303);
    expect(await file(created.id!, "index.md")).toBe("# Meeting notes\n\n");
    const edit = await (await browserGet(`/a/${created.id}/edit`, owner.cookie)).text();
    expect(edit).toContain("!artifact/editor.html");
    const md = `# Meeting notes\n\nWe agreed on the 枠 count. See [Other](/a/${other.body.id}).`;
    const saved = await save(created.id!, owner, { base_version: 1, title: "Meeting notes", markdown: md });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ version: 2 });
    expect(await file(created.id!, "index.md")).toBe(md);
    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${other.body.id}`)).json()) as { linked_from: { id: string }[] };
    expect(detail.linked_from.map((l) => l.id)).toContain(created.id);
    const found = (await (await signedFetch(device, "GET", `/api/v1/search?q=${encodeURIComponent("枠 count")}`)).json()) as { results: { id: string }[] };
    expect(found.results.map((r) => r.id)).toContain(created.id);
    // Saving on top of an old version is refused, with the latest number.
    const stale = await save(created.id!, owner, { base_version: 1, title: "Meeting notes", markdown: "lost" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ current_version: 2 });
  });

  it("puts a page written under another in that page's project", async () => {
    const device = await createDevice();
    const top = await publish(device, { "index.html": "<p>x</p>" }, { project: "WrittenTree" });
    const owner = await sessionCookie("root");
    const child = await newPage(owner.cookie, owner.csrf, { parent: top.body.id, title: "Child" });
    const detail = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${child.id}`)).json()) as { project: string; parent: string };
    expect(detail).toMatchObject({ project: "WrittenTree", parent: top.body.id });
  });

  it("lets the owner and the project's editors write, and nobody edit an agent's HTML page or save without the CSRF token", async () => {
    const device = await createDevice();
    const html = await publish(device, { "index.html": "<p>x</p>" }, { project: "WrittenAccess" });
    const owner = await sessionCookie("root");
    const editor = await sessionCookie("viewer");
    const reader = await sessionCookie("viewer");
    await browserPost("/projects/WrittenAccess/members", owner.cookie, { csrf: owner.csrf, user: editor.userId, role: "editor" });
    expect((await newPage(reader.cookie, reader.csrf, { project: "WrittenAccess", title: "No" })).status).toBe(403);
    const mine = await newPage(editor.cookie, editor.csrf, { project: "WrittenAccess", title: "Yes" });
    expect(mine.status).toBe(303);
    expect((await browserGet(`/a/${mine.id}/edit`, reader.cookie)).status).toBe(403);
    expect((await save(mine.id!, reader, { base_version: 1, title: "x", markdown: "x" })).status).toBe(403);
    expect((await save(mine.id!, editor, { base_version: 1, title: "x", markdown: "x" }, "https://evil.example")).status).toBe(403);
    expect((await save(mine.id!, { cookie: editor.cookie, csrf: "wrong" }, { base_version: 1, title: "x", markdown: "x" })).status).toBe(403);
    expect((await save(mine.id!, editor, { base_version: 1, title: "Yes", markdown: "# Yes\n\nok" })).status).toBe(200);
    expect((await browserGet(`/a/${html.body.id}/edit`, owner.cookie)).status).toBe(400);
  });

  it("shows a Markdown page through the renderer in the sandbox, and offers the editor only in the viewer", async () => {
    const owner = await sessionCookie("root");
    const page = await newPage(owner.cookie, owner.csrf, { title: "Rendered" });
    const src = await contentSrc(page.id!, owner.cookie);
    expect(src.endsWith("/!artifact/doc.html")).toBe(true);
    const doc = await SELF.fetch(`${ORIGIN}${src}`);
    expect(doc.headers.get("content-security-policy")).toContain("sandbox");
    const html = await doc.text();
    expect(html).toContain('data-src="../index.md"');
    expect(html).toContain('<script src="nav.js"></script>');
    expect(html).toContain("integrity=");
    for (const f of ["doc.js", "doc.css", "editor.html", "editor.js", "nav.js"]) {
      expect((await SELF.fetch(`${ORIGIN}${src.replace(/doc\.html$/, f)}`)).status).toBe(200);
    }
    const viewer = await (await browserGet(`/a/${page.id}`, owner.cookie)).text();
    expect(viewer).toContain(`href="/a/${page.id}/edit"`);
  });
});
