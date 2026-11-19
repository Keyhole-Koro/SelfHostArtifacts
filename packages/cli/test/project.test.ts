import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject, repoNameFromRemote } from "../src/project.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const NO_ENV = {};

describe("project of a new page", () => {
  it("reads the repository name from the usual remote URLs", () => {
    expect(repoNameFromRemote("git@github.com:Keyhole-Koro/MediShare.git")).toBe("MediShare");
    expect(repoNameFromRemote("https://github.com/Keyhole-Koro/SelfHostArtifacts")).toBe("SelfHostArtifacts");
    expect(repoNameFromRemote("https://github.com/Owner/repo.git/")).toBe("repo");
    expect(repoNameFromRemote("ssh://git@host:2222/srv/git/tool.git")).toBe("tool");
    expect(repoNameFromRemote(undefined)).toBeUndefined();
  });

  it("uses the origin remote, also from a subfolder and from a worktree in another folder", () => {
    const base = mkdtempSync(join(tmpdir(), "artifact-project-"));
    const repo = join(base, "local-name");
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "git@github.com:Owner/RealName.git");
    expect(detectProject(repo, NO_ENV)).toBe("RealName");
    expect(detectProject(join(repo, "sub"), NO_ENV)).toBe("RealName");

    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(base, "RealName-feature");
    git(repo, "worktree", "add", "-q", worktree);
    expect(detectProject(worktree, NO_ENV)).toBe("RealName");
  });

  it("without a remote, names it after the main checkout's folder", () => {
    const base = mkdtempSync(join(tmpdir(), "artifact-project-"));
    const repo = join(base, "notes");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    expect(detectProject(repo, NO_ENV)).toBe("notes");
    const worktree = join(base, "notes-wt");
    git(repo, "worktree", "add", "-q", worktree);
    expect(detectProject(worktree, NO_ENV)).toBe("notes");
  });

  it("has none outside a repository, and ARTIFACT_PROJECT overrides", () => {
    const plain = mkdtempSync(join(tmpdir(), "artifact-project-plain-"));
    expect(detectProject(plain, NO_ENV)).toBeUndefined();
    expect(detectProject(plain, { ARTIFACT_PROJECT: "Chosen" })).toBe("Chosen");
    expect(detectProject(plain, { ARTIFACT_PROJECT: "" })).toBeUndefined();
  });
});
