import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, browserPost, contentSrc, createDevice, publish, sessionCookie, signedFetch } from "./helpers.ts";
import { includedId, macrosIn, type MacroData } from "../src/macros.ts";
import { fromTemplatePage } from "../src/templates.ts";

const md = (text: string) => ({ "index.md": text });

async function macrosFor(src: string, cookie?: string): Promise<MacroData> {
  const res = await SELF.fetch(`${ORIGIN}${src.replace(/doc\.html$/, "macros.json")}`, cookie ? { headers: { cookie } } : {});
  expect(res.status).toBe(200);
  return (await res.json()) as MacroData;
}

describe("macros", () => {
  it("are lines of their own, outside fenced code", () => {
    expect(macrosIn("# T\n{{toc}}\ntext {{children}} inline\n```\n{{recent}}\n```\n  {{ label  Decision }}\n{{include https://h/a/abcdefghijklmnop}}\n{{unknown}}\n")).toEqual([
      { name: "toc", arg: "" },
      { name: "label", arg: "Decision" },
      { name: "include", arg: "https://h/a/abcdefghijklmnop" },
    ]);
    expect(includedId("/a/abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(includedId("abcdefghijklmnop")).toBe("abcdefghijklmnop");
    expect(includedId("https://x.example/a/abcdefghijklmnop?v=1")).toBe("abcdefghijklmnop");
    expect(includedId("../a/abcdefghijklmnop")).toBeUndefined();
  });

  it("get their pages from macros.json, only what the viewer may see, and nothing on a public link", async () => {
    const device = await createDevice();
    const owner = await sessionCookie("root");
    const other = await publish(device, md("# Shared part\n\nSome **shared** text.\n"), { entry: "index.md", project: "MacroDocs", title: "Shared part", labels: ["decision"] });
    const html = await publish(device, { "index.html": "<p>html</p>" }, { project: "MacroDocs", title: "An HTML page" });
    const elsewhere = await publish(device, md("# Elsewhere\n"), { entry: "index.md", project: "MacroOther", title: "Elsewhere" });
    const secret = await publish(device, md("# Secret decision\n"), { entry: "index.md", project: "MacroSecret", title: "Secret decision", labels: ["decision"] });
    await browserPost("/projects/MacroSecret", owner.cookie, { csrf: owner.csrf, access: "members" });
    const page = await publish(
      device,
      md(`# Hub\n\n{{toc}}\n\n{{children}}\n\n{{recent}}\n\n{{label decision}}\n\n{{include /a/${other.body.id}}}\n\n{{include /a/${html.body.id}}}\n\n{{include ${elsewhere.body.id}}}\n`),
      { entry: "index.md", project: "MacroDocs", title: "Hub" },
    );
    const child = await publish(device, md("# Child\n"), { entry: "index.md", parent: page.body.id, title: "Child" });

    // The owner sees every decision; a viewer not let into MacroSecret does not see that one.
    const forOwner = await macrosFor(await contentSrc(page.body.id, owner.cookie));
    expect(forOwner.children).toEqual([{ title: "Child", href: `/a/${child.body.id}` }]);
    expect(forOwner.recent?.map((p) => p.title)).toContain("Child");
    expect(forOwner.labels?.["decision"]?.map((p) => p.title).sort()).toEqual(["Secret decision", "Shared part"]);
    expect(forOwner.include?.[`/a/${other.body.id}`]).toEqual({ title: "Shared part", href: `/a/${other.body.id}`, markdown: "# Shared part\n\nSome **shared** text.\n" });
    expect(forOwner.include?.[`/a/${html.body.id}`]).toEqual({ error: "Only a page written in Markdown can be embedded." });
    expect(forOwner.include?.[elsewhere.body.id]).toEqual({ error: "Only a page of the same project can be embedded." });
    const viewer = await sessionCookie("viewer");
    const forViewer = await macrosFor(await contentSrc(page.body.id, viewer.cookie));
    expect(forViewer.labels?.["decision"]?.map((p) => p.title)).toEqual(["Shared part"]);
    expect(secret.status).toBe(201);

    // A public link of the page shows the page, but none of the other pages.
    await browserPost(`/a/${page.body.id}/share`, owner.cookie, { csrf: owner.csrf });
    const shared = await (await browserGet(`/a/${page.body.id}?share=1`, owner.cookie)).text();
    const link = new URL(shared.match(/value="(http[^"]+\/s\/[^"]+)"/)![1]!).pathname;
    const publicPage = await (await SELF.fetch(`${ORIGIN}${link}`)).text();
    const src = publicPage.match(/<iframe id="frame" src="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    expect(await macrosFor(src)).toEqual({ public: true });
  });

  it("start a new page from a built-in template or a template page of the project", async () => {
    const owner = await sessionCookie("root");
    const made = await browserPost("/new", owner.cookie, { csrf: owner.csrf, project: "Templated", title: "Pick a queue", template: "decision" });
    const id = /\/a\/([0-9a-z]{16})\/edit$/.exec(made.headers.get("location") ?? "")![1]!;
    const device = await createDevice();
    const read = async (pid: string) => (await signedFetch(device, "GET", `/api/v1/artifacts/${pid}/files/index.md`)).text();
    const detail = async (pid: string) => (await (await signedFetch(device, "GET", `/api/v1/artifacts/${pid}`)).json()) as { labels: string[] };
    expect(await read(id)).toContain("# Pick a queue\n\n**Status:** Proposed");
    expect((await detail(id)).labels).toEqual(["decision"]);

    const template = await publish(device, md("# Weekly review\n\n## Wins\n\n## Risks\n"), { entry: "index.md", project: "Templated", title: "Weekly review", labels: ["template", "weekly"] });
    const project = await (await browserGet("/?project=Templated", owner.cookie)).text();
    expect(project).toContain(`value="page:${template.body.id}"`);
    const fromPage = await browserPost("/new", owner.cookie, { csrf: owner.csrf, project: "Templated", title: "Week 47", template: `page:${template.body.id}` });
    const pid = /\/a\/([0-9a-z]{16})\/edit$/.exec(fromPage.headers.get("location") ?? "")![1]!;
    expect(await read(pid)).toBe("# Week 47\n\n## Wins\n\n## Risks\n");
    expect((await detail(pid)).labels).toEqual(["weekly"]);
    // A template page of another project is refused.
    const away = await browserPost("/new", owner.cookie, { csrf: owner.csrf, project: "Elsewhere", title: "x", template: `page:${template.body.id}` });
    expect(away.status).toBe(400);
    expect(fromTemplatePage("Intro without heading\n", "New")).toBe("# New\n\nIntro without heading\n");
  });

  it("can be inserted from the editor's menu", async () => {
    const owner = await sessionCookie("root");
    const made = await browserPost("/new", owner.cookie, { csrf: owner.csrf, project: "Inserting", title: "Hub" });
    const id = /\/a\/([0-9a-z]{16})\/edit$/.exec(made.headers.get("location") ?? "")![1]!;
    const edit = await (await browserGet(`/a/${id}/edit`, owner.cookie)).text();
    expect(edit).toContain('<option value="{{toc}}">Table of contents</option>');
    expect(edit).toContain('<option value="{{children}}">');
  });
});
