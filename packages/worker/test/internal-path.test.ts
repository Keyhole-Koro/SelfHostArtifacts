import { describe, expect, it } from "vitest";
import { safeNext } from "../src/lib/internal-path.ts";
import { ORIGIN, browserGet } from "./helpers.ts";

describe("safeNext", () => {
  it("keeps a path on this site with its query and hash, and resolves dot segments", () => {
    expect(safeNext("/settings", ORIGIN)).toBe("/settings");
    expect(safeNext("/a/x?y=1#z", ORIGIN)).toBe("/a/x?y=1#z");
    expect(safeNext("/a/../settings", ORIGIN)).toBe("/settings");
    expect(safeNext("/a//b", ORIGIN)).toBe("/a//b");
  });

  it("answers / for anything that is not a path on this site", () => {
    for (const next of [undefined, "", "settings", "https://evil.example/", "//evil.example", "/\\evil.example", "/\t/evil.example"]) {
      expect(safeNext(next, ORIGIN), String(next)).toBe("/");
    }
  });

  it("answers / when dot segments leave a leading //, which a browser reads as another host", () => {
    for (const next of [
      "/.//evil.example",
      "/..//evil.example",
      "/a/..//evil.example",
      "/%2e//evil.example",
      "/%2e%2e//evil.example",
      "/./\\evil.example",
      "/.//evil.example/path?q=1#h",
    ]) {
      expect(safeNext(next, ORIGIN), next).toBe("/");
    }
  });

  it("does not send a dev sign-in (DEV_LOGIN) to another host", async () => {
    const res = await browserGet("/auth/login?next=/.//evil.example");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
