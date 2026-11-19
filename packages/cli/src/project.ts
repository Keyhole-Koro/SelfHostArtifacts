import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/**
 * The project a new page goes into: the name of the git repository the agent works in, so pages
 * sort themselves without the agent thinking about it. ARTIFACT_PROJECT overrides it (empty:
 * none). Outside a git repository there is no project.
 */
export function detectProject(cwd = process.cwd(), env = process.env): string | undefined {
  const override = env["ARTIFACT_PROJECT"];
  if (override !== undefined) return override.trim() || undefined;
  const fromRemote = repoNameFromRemote(git(cwd, ["remote", "get-url", "origin"]));
  if (fromRemote) return fromRemote;
  // No remote: the folder of the main checkout (not of a worktree, whose folder is often renamed).
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return undefined;
  return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "") || undefined;
}

/** "git@github.com:Owner/Repo.git", "https://github.com/Owner/Repo", "ssh://host/path/repo.git" → "Repo". */
export function repoNameFromRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/, "");
  return name || undefined;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}
