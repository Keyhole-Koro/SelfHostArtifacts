import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ArticleError, artifactIdFromUrl, type Session } from "../src/client.ts";
import { installSkills, uninstallSkills } from "../src/commands/setup.ts";
import { forgetArtifact, loadState, originFor, rememberPublish } from "../src/profile.ts";

const session = { origin: "https://article.example.com" } as Session;

describe("artifactIdFromUrl", () => {
  it("reads the id from an artifact URL", () => {
    expect(artifactIdFromUrl(session, "https://article.example.com/a/x7k2m9q4p1r8t3v6")).toBe("x7k2m9q4p1r8t3v6");
    expect(artifactIdFromUrl(session, "https://article.example.com/a/x7k2m9q4p1r8t3v6/v/3")).toBe("x7k2m9q4p1r8t3v6");
  });

  it("refuses URLs of another deployment", () => {
    expect(() => artifactIdFromUrl(session, "https://evil.example/a/x7k2m9q4p1r8t3v6")).toThrow(ArticleError);
  });
});

describe("originFor", () => {
  it("uses http only for localhost", () => {
    expect(originFor("localhost:8787")).toBe("http://localhost:8787");
    expect(originFor("article.keyhole.work")).toBe("https://article.keyhole.work");
  });
});

describe("state", () => {
  beforeEach(() => {
    process.env["XDG_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "article-test-"));
  });

  it("remembers which file was published as which artifact", () => {
    rememberPublish("/a/page.html", { id: "x", url: "u", version: 1 });
    rememberPublish("/a/page.html", { id: "x", url: "u", version: 2 });
    expect(loadState().files["/a/page.html"]).toEqual({ id: "x", url: "u", version: 2 });
    forgetArtifact("x");
    expect(loadState().files).toEqual({});
  });
});

describe("skills", () => {
  it("installs, reinstalls and removes only its own skill folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(dir, "article-design"));
    writeFileSync(join(dir, "article-design", "SKILL.md"), "someone else's");

    const first = installSkills(dir);
    expect(first.skipped).toEqual(["article-design"]);
    expect(first.installed).toEqual(["article-publish"]);
    expect(readFileSync(join(dir, "article-design", "SKILL.md"), "utf8")).toBe("someone else's");

    expect(installSkills(dir).installed).toEqual(["article-publish"]);
    expect(uninstallSkills(dir)).toEqual(["article-publish"]);
    expect(existsSync(join(dir, "article-publish"))).toBe(false);
    expect(existsSync(join(dir, "article-design", "SKILL.md"))).toBe(true);
  });
});
