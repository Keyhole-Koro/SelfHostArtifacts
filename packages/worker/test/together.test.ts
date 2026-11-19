import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, browserGet, browserPost, createDevice, sessionCookie, signedFetch } from "./helpers.ts";

type Who = { cookie: string; csrf: string; userId: string };

function json(path: string, who: Who, method: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { cookie: who.cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf": who.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

async function newPage(who: Who, project: string, title: string): Promise<string> {
  const res = await browserPost("/new", who.cookie, { csrf: who.csrf, project, title });
  return /\/a\/([0-9a-z]{16})\/edit$/.exec(res.headers.get("location") ?? "")![1]!;
}

const read = async (id: string) => (await signedFetch(await createDevice(), "GET", `/api/v1/artifacts/${id}/files/index.md`)).text();

describe("editing together", () => {
  it("shows who else has the editor open, and the latest version to viewers", async () => {
    const owner = await sessionCookie("root");
    const sam = await sessionCookie("viewer");
    await browserPost("/projects/Together/members", owner.cookie, { csrf: owner.csrf, user: sam.userId, role: "editor" });
    const id = await newPage(owner, "Together", "Plan");
    expect((await json(`/a/${id}/presence`, owner, "POST", {})).status).toBe(200);
    const forSam = (await (await json(`/a/${id}/presence`, sam, "POST", {})).json()) as { editing: string[]; version: number };
    expect(forSam).toMatchObject({ editing: ["Owner"], version: 1 });
    const state = (await (await browserGet(`/a/${id}/state`, sam.cookie)).json()) as { editing: string[]; version: number; by: string };
    expect(state).toEqual({ version: 1, by: "Owner", editing: ["Owner"] });
    await json(`/a/${id}/presence`, owner, "DELETE");
    expect(((await (await browserGet(`/a/${id}/state`, sam.cookie)).json()) as { editing: string[] }).editing).toEqual([]);
    // Someone who may not change the page cannot say they edit it.
    const reader = await sessionCookie("viewer");
    expect((await json(`/a/${id}/presence`, reader, "POST", {})).status).toBe(403);
  });

  it("merges a save into what was saved meanwhile, and marks the lines both changed", async () => {
    const owner = await sessionCookie("root");
    const id = await newPage(owner, "Merging", "Notes");
    const start = "# Notes\n\nfirst line\n\nmiddle line\n\nlast line\n";
    expect((await json(`/a/${id}/edit`, owner, "POST", { base_version: 1, title: "Notes", markdown: start })).status).toBe(200);
    // Two people opened v2; one saves v3, then the other saves a change to another line.
    await json(`/a/${id}/edit`, owner, "POST", { base_version: 2, title: "Notes", markdown: start.replace("first line", "FIRST line") });
    const clean = await json(`/a/${id}/edit`, owner, "POST", { base_version: 2, title: "Notes", markdown: start.replace("last line", "LAST line"), merge: true });
    expect(clean.status).toBe(200);
    expect(await clean.json()).toEqual({ version: 4, merged: true });
    expect(await read(id)).toBe("# Notes\n\nFIRST line\n\nmiddle line\n\nLAST line\n");
    // Without asking for a merge, a stale save is refused as before.
    expect((await json(`/a/${id}/edit`, owner, "POST", { base_version: 2, title: "Notes", markdown: start })).status).toBe(409);
    // Both change the middle line: nothing is saved, and the merge comes back with both marked.
    await json(`/a/${id}/edit`, owner, "POST", { base_version: 4, title: "Notes", markdown: (await read(id)).replace("middle line", "theirs") });
    const clash = await json(`/a/${id}/edit`, owner, "POST", { base_version: 4, title: "Notes", markdown: (await read(id)).replace("theirs", "mine").replace("FIRST", "First"), merge: true });
    expect(clash.status).toBe(409);
    const body = (await clash.json()) as { merged: string; conflicts: number; current_version: number; by: string };
    expect(body).toMatchObject({ conflicts: 1, current_version: 5, by: "Owner" });
    expect(body.merged).toContain("<<<<<<< your text\nmine\n=======\ntheirs\n>>>>>>> v5 by Owner");
    // Saving the marks as they are is refused; resolved, it saves.
    expect((await json(`/a/${id}/edit`, owner, "POST", { base_version: 5, title: "Notes", markdown: body.merged, merge: true })).status).toBe(400);
    const resolved = body.merged.replace(/<<<<<<< your text\nmine\n=======\ntheirs\n>>>>>>> v5 by Owner/, "both");
    expect((await json(`/a/${id}/edit`, owner, "POST", { base_version: 5, title: "Notes", markdown: resolved, merge: true })).status).toBe(200);
  });
});
