import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintContentToken } from "../src/content.ts";
import { sign } from "../src/lib/signed.ts";
import { ORIGIN, ROOT, browserGet, contentSrc, createDevice, publish, sessionCookie } from "./helpers.ts";

const SECRET = "test-content-secret";

async function published(files: Record<string, string> = { "index.html": "<h1>hi</h1>", "css/site.css": "h1{}" }, extra = {}) {
  const device = await createDevice();
  const { body } = await publish(device, files, extra);
  const { cookie } = await sessionCookie(ROOT);
  return { id: body.id as string, cookie, device };
}

describe("artifact content", () => {
  it("serves the entry and relative files under the token", async () => {
    const { id, cookie } = await published();
    const src = await contentSrc(id, cookie);
    const page = await SELF.fetch(`${ORIGIN}${src}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>hi</h1>");
    const css = await SELF.fetch(new URL("css/site.css", `${ORIGIN}${src}`));
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("runs every response in an opaque-origin sandbox", async () => {
    const { id, cookie } = await published();
    const res = await SELF.fetch(`${ORIGIN}${await contentSrc(id, cookie)}`);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'self';");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds allowed hosts to connect-src", async () => {
    const { id, cookie } = await published({ "index.html": "x" }, { allow_connect: ["api.example.com"] });
    const res = await SELF.fetch(`${ORIGIN}${await contentSrc(id, cookie)}`);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' https://api.example.com;");
  });

  it("does not need the session cookie, and does not accept it in place of a token", async () => {
    const { id, cookie } = await published();
    const src = await contentSrc(id, cookie);
    expect((await SELF.fetch(`${ORIGIN}${src}`)).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/c/not-a-token/index.html`, { headers: { cookie } })).status).toBe(403);
  });

  it("refuses an expired or forged token", async () => {
    const { id } = await published();
    const expired = await sign({ a: id, v: 1, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect((await SELF.fetch(`${ORIGIN}/c/${expired}/index.html`)).status).toBe(403);
    const forged = await sign({ a: id, v: 1, exp: Math.floor(Date.now() / 1000) + 60 }, "wrong secret");
    expect((await SELF.fetch(`${ORIGIN}/c/${forged}/index.html`)).status).toBe(403);
  });

  it("serves only the files of the token's version", async () => {
    const { id, cookie, device } = await published({ "index.html": "v1", "old.txt": "old" });
    await publish(device, { "index.html": "v2" }, { id, base_version: 1 });
    const v1 = await contentSrc(id, cookie, 1);
    expect(await (await SELF.fetch(`${ORIGIN}${v1}`)).text()).toBe("v1");
    const v2 = await contentSrc(id, cookie);
    expect(await (await SELF.fetch(`${ORIGIN}${v2}`)).text()).toBe("v2");
    expect((await SELF.fetch(new URL("old.txt", `${ORIGIN}${v2}`))).status).toBe(404);
  });

  it("does not resolve paths outside the artifact", async () => {
    const { id } = await published();
    const { token } = await mintContentToken(SECRET, id, 1);
    expect((await SELF.fetch(`${ORIGIN}/c/${token}/..%2F..%2Fapi%2Fv1%2Fartifacts`)).status).toBe(404);
  });

  it("stops serving a deleted artifact", async () => {
    const { id, cookie, device } = await published();
    const src = await contentSrc(id, cookie);
    const { signedFetch } = await import("./helpers.ts");
    await signedFetch(device, "DELETE", `/api/v1/artifacts/${id}`);
    expect((await SELF.fetch(`${ORIGIN}${src}`)).status).toBe(404);
  });
});

describe("viewer page", () => {
  it("frames the content without allow-same-origin", async () => {
    const { id, cookie } = await published();
    const res = await browserGet(`/a/${id}`, cookie);
    const html = await res.text();
    expect(html).toMatch(/<iframe id="frame" src="\/c\/[^"]+\/index.html" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"/);
    expect(html).not.toContain("allow-same-origin");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
