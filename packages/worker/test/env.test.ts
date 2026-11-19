import { describe, expect, it } from "vitest";
import { loadConfig, type Env } from "../src/env.ts";

type Vars = { [K in "APP_HOST" | "DEV_LOGIN" | "KEEP_VERSIONS" | "TRASH_DAYS" | "SESSION_SECRET" | "CONTENT_TOKEN_SECRET"]?: string | undefined };

/** loadConfig over a valid deployment's variables, with some replaced. It never reads the bindings (DB, BLOBS). */
function config(vars: Vars = {}) {
  const base = { APP_HOST: "artifacts.example.com", SESSION_SECRET: "session-secret", CONTENT_TOKEN_SECRET: "content-secret" };
  return loadConfig({ ...base, ...vars } as unknown as Env);
}

describe("loadConfig", () => {
  it("refuses DEV_LOGIN on any host but this computer, however it is written", () => {
    for (const host of ["artifacts.example.com", "localhost.example.com", "127.0.0.1.nip.io", "artifacts.example.com:8787"]) {
      expect(() => config({ APP_HOST: host, DEV_LOGIN: "true" }), host).toThrow("DEV_LOGIN is only allowed when APP_HOST is localhost");
    }
    expect(() => config({ DEV_LOGIN: " TRUE " })).toThrow("DEV_LOGIN is only allowed when APP_HOST is localhost");
  });

  it("allows DEV_LOGIN on localhost, 127.0.0.1 and [::1], served over http", () => {
    for (const [host, origin] of [
      ["localhost:8787", "http://localhost:8787"],
      ["127.0.0.1:8787", "http://127.0.0.1:8787"],
      ["[::1]:8787", "http://[::1]:8787"],
      ["LOCALHOST:8787", "http://localhost:8787"],
      ["localhost", "http://localhost"],
    ] as const) {
      expect(config({ APP_HOST: host, DEV_LOGIN: "true" }), host).toMatchObject({ devLogin: true, origin });
    }
    expect(config({ APP_HOST: "localhost:8787", DEV_LOGIN: "true" }).rpId).toBe("localhost");
  });

  it('leaves DEV_LOGIN off unless it is "true"', () => {
    expect(config({ APP_HOST: "localhost:8787" })).toMatchObject({ devLogin: false, origin: "http://localhost:8787" });
    for (const value of ["", "false", "1", "yes"]) expect(config({ DEV_LOGIN: value }).devLogin, value).toBe(false);
  });

  it("serves any other host over https, with the host name without the port as the passkey rpId", () => {
    expect(config({ APP_HOST: " Artifacts.Example.com " })).toEqual({
      host: "artifacts.example.com",
      origin: "https://artifacts.example.com",
      rpId: "artifacts.example.com",
      keepVersions: 0,
      trashDays: 30,
      devLogin: false,
    });
    expect(config({ APP_HOST: "artifacts.example.com:8443" })).toMatchObject({
      host: "artifacts.example.com:8443",
      origin: "https://artifacts.example.com:8443",
      rpId: "artifacts.example.com",
    });
  });

  it("refuses to start without APP_HOST or either secret", () => {
    expect(() => config({ APP_HOST: undefined })).toThrow("APP_HOST is not set");
    expect(() => config({ APP_HOST: "  " })).toThrow("APP_HOST is not set");
    const missing = "SESSION_SECRET and CONTENT_TOKEN_SECRET must be set";
    expect(() => config({ SESSION_SECRET: undefined })).toThrow(missing);
    expect(() => config({ SESSION_SECRET: "" })).toThrow(missing);
    expect(() => config({ CONTENT_TOKEN_SECRET: undefined })).toThrow(missing);
    expect(() => config({ CONTENT_TOKEN_SECRET: "" })).toThrow(missing);
  });

  it("reads KEEP_VERSIONS and TRASH_DAYS as non-negative integers, empty meaning the default", () => {
    expect(config({ KEEP_VERSIONS: "5", TRASH_DAYS: "0" })).toMatchObject({ keepVersions: 5, trashDays: 0 });
    expect(config({ KEEP_VERSIONS: "", TRASH_DAYS: "" })).toMatchObject({ keepVersions: 0, trashDays: 30 });
    for (const value of ["-1", "1.5", "x"]) {
      expect(() => config({ KEEP_VERSIONS: value }), value).toThrow(`KEEP_VERSIONS must be a non-negative integer, got "${value}"`);
      expect(() => config({ TRASH_DAYS: value }), value).toThrow(`TRASH_DAYS must be a non-negative integer, got "${value}"`);
    }
  });
});
