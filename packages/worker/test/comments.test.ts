import { describe, expect, it } from "vitest";
import { browserGet, browserPost, createDevice, publish, sessionCookie, signedFetch, signedJson } from "./helpers.ts";

const PAGE = { "index.html": "<p>The ring holds thirty-two slots.</p>" };

async function threadId(id: string): Promise<string> {
  const res = await signedFetch(await createDevice(), "GET", `/api/v1/artifacts/${id}/comments`);
  const { comments } = (await res.json()) as { comments: { id: string; reply_to: string | null }[] };
  return comments.filter((c) => !c.reply_to).at(-1)!.id;
}

describe("comments", () => {
  it("takes a comment on a passage and a reply, shows them escaped, counts open threads, and settles them", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { title: "Commented" });
    const alice = await sessionCookie("viewer");
    const bob = await sessionCookie("viewer");
    const posted = await browserPost(`/a/${page.body.id}/comments`, alice.cookie, { csrf: alice.csrf, body: "Is it <b>32</b>?", quote: "thirty-two </script> slots" });
    expect(posted.status).toBe(303);
    const thread = await threadId(page.body.id);
    expect((await browserPost(`/a/${page.body.id}/comments`, bob.cookie, { csrf: bob.csrf, body: "Yes, 32.", reply_to: thread })).status).toBe(303);

    const html = await (await browserGet(`/a/${page.body.id}?comments=1`, bob.cookie)).text();
    expect(html).toContain("Is it &lt;b&gt;32&lt;/b&gt;?");
    expect(html).toContain("Yes, 32.");
    expect(html).toContain("thirty-two \\u003c/script\\u003e slots");
    expect(html).not.toContain("thirty-two </script> slots\"");
    expect(await (await browserGet("/", bob.cookie)).text()).toContain("1 comment");

    // Settling: not by someone else, but by the thread's author or the owner.
    expect((await browserPost(`/a/${page.body.id}/comments/${thread}/resolve`, bob.cookie, { csrf: bob.csrf, resolved: "1" })).status).toBe(403);
    expect((await browserPost(`/a/${page.body.id}/comments/${thread}/resolve`, alice.cookie, { csrf: alice.csrf, resolved: "1" })).status).toBe(303);
    const list = await (await signedFetch(device, "GET", `/api/v1/artifacts/${page.body.id}/comments`)).json() as { comments: { id: string; resolved: boolean }[] };
    expect(list.comments.find((c) => c.id === thread)!.resolved).toBe(true);
    expect(await (await browserGet("/", bob.cookie)).text()).not.toContain("1 comment");
    // Deleting: the author's own, and the whole thread with its first comment.
    expect((await browserPost(`/a/${page.body.id}/comments/${thread}/delete`, bob.cookie, { csrf: bob.csrf })).status).toBe(403);
    expect((await browserPost(`/a/${page.body.id}/comments/${thread}/delete`, alice.cookie, { csrf: alice.csrf })).status).toBe(303);
    const after = await (await signedFetch(device, "GET", `/api/v1/artifacts/${page.body.id}/comments`)).json() as { comments: unknown[] };
    expect(after.comments).toEqual([]);
  });

  it("keeps people outside a members-only project from commenting", async () => {
    const device = await createDevice();
    const page = await publish(device, PAGE, { project: "QuietRoom" });
    const owner = await sessionCookie("root");
    await browserPost("/projects/QuietRoom", owner.cookie, { csrf: owner.csrf, access: "members" });
    const stranger = await sessionCookie("viewer");
    expect((await browserPost(`/a/${page.body.id}/comments`, stranger.cookie, { csrf: stranger.csrf, body: "hi" })).status).toBe(404);
  });

  it("lets an agent read the threads, reply and settle one", async () => {
    const device = await createDevice("work-laptop");
    const page = await publish(device, PAGE, { title: "Agent replies" });
    const owner = await sessionCookie("root");
    await browserPost(`/a/${page.body.id}/comments`, owner.cookie, { csrf: owner.csrf, body: "Please say how many slots are usable." });
    const thread = await threadId(page.body.id);
    const reply = await signedJson(device, "POST", `/api/v1/artifacts/${page.body.id}/comments`, { body: "Done: 31 of the 32.", reply_to: thread, resolve: true });
    expect(reply.status).toBe(201);
    const { comments } = (await (await signedFetch(device, "GET", `/api/v1/artifacts/${page.body.id}/comments`)).json()) as {
      comments: { id: string; author: string; by_agent: boolean; resolved: boolean; reply_to: string | null }[];
    };
    expect(comments.find((c) => c.id === thread)!.resolved).toBe(true);
    expect(comments.find((c) => c.reply_to === thread)).toMatchObject({ author: "work-laptop", by_agent: true });
    expect((await signedJson(device, "POST", `/api/v1/artifacts/${page.body.id}/comments`, { body: "x", resolve: true })).status).toBe(400);
  });
});
