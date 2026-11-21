import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN } from "./helpers.ts";

// Before hono 4.13.16, its RegExpRouter skipped every "*" middleware for a path whose decoded form
// held a line terminator (GHSA-h7mg-cq63-vhpq). Whichever router hono picks for these routes, such
// a request must still pass the host check, get the security headers and need a signature.
describe("a path with an encoded line terminator", () => {
  for (const path of ["/no-such-page%0A", "/no%0Asuch/page", "/no-such-page%0D", "/no-such-page%E2%80%A8", "/no-such-page%E2%80%A9"]) {
    it(`gets the security headers: ${path}`, async () => {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it(`is refused for another host: ${path}`, async () => {
      const res = await SELF.fetch(`http://evil.example${path}`, { redirect: "manual" });
      expect(res.status).toBe(421);
    });
  }

  it("still needs a device signature under /api/v1", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/no-such%0A`);
    expect(res.status).toBe(401);
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });
});
