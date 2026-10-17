import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profileName } from "../profile.ts";

/** Marks a skill folder as installed by `artifact`, so we only ever replace or remove our own. */
const MARKER = ".installed-by-artifact";

export type Agent = "codex" | "gemini" | "claude";
export const AGENTS: Agent[] = ["codex", "gemini", "claude"];

function onPath(command: string): boolean {
  const probe = process.platform === "win32" ? spawnSync("where", [command]) : spawnSync("sh", ["-c", `command -v ${command}`]);
  return probe.status === 0;
}

export function detectAgents(): Agent[] {
  return AGENTS.filter(onPath);
}

/** MCP server name: "artifact", or "artifact-<profile>" for other profiles. */
export function serverName(): string {
  const profile = profileName();
  return profile === "default" ? "artifact" : `artifact-${profile}`;
}

/** How agents should start this CLI: `artifact mcp` when it is on PATH, else node + this script. */
function launchCommand(): string[] {
  const profileArgs = profileName() === "default" ? [] : ["--profile", profileName()];
  if (onPath("artifact")) return ["artifact", ...profileArgs, "mcp"];
  return [process.execPath, fileURLToPath(new URL(import.meta.url)), ...profileArgs, "mcp"];
}

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Registers the MCP server with each agent's own command, replacing an older registration. */
export function registerMcp(agent: Agent): { ok: boolean; output: string } {
  const name = serverName();
  const launch = launchCommand();
  switch (agent) {
    case "codex":
      run("codex", ["mcp", "remove", name]);
      return run("codex", ["mcp", "add", name, "--", ...launch]);
    case "gemini":
      run("gemini", ["mcp", "remove", "--scope", "user", name]);
      return run("gemini", ["mcp", "add", "--scope", "user", name, ...launch]);
    case "claude":
      run("claude", ["mcp", "remove", "--scope", "user", name]);
      return run("claude", ["mcp", "add", "--scope", "user", name, "--", ...launch]);
  }
}

export function unregisterMcp(agent: Agent): { ok: boolean; output: string } {
  const name = serverName();
  switch (agent) {
    case "codex":
      return run("codex", ["mcp", "remove", name]);
    case "gemini":
      return run("gemini", ["mcp", "remove", "--scope", "user", name]);
    case "claude":
      return run("claude", ["mcp", "remove", "--scope", "user", name]);
  }
}

/** Codex and Gemini CLI both read ~/.agents/skills; Claude Code reads ~/.claude/skills. */
export function skillDirsFor(agents: Agent[]): string[] {
  const dirs = new Set<string>();
  for (const agent of agents) dirs.add(agent === "claude" ? join(homedir(), ".claude", "skills") : join(homedir(), ".agents", "skills"));
  return [...dirs];
}

/** The skills shipped with this package (dist/../skills), or the repo's skills/ in development. */
export function bundledSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "skills"), join(here, "..", "..", "..", "skills"), join(here, "..", "..", "..", "..", "skills")]) {
    if (existsSync(join(candidate, "artifact-design", "SKILL.md"))) return candidate;
  }
  throw new Error("The bundled skills are missing from this installation.");
}

export interface SkillInstall {
  dir: string;
  installed: string[];
  skipped: string[];
}

export function installSkills(targetDir: string): SkillInstall {
  const source = bundledSkillsDir();
  const result: SkillInstall = { dir: targetDir, installed: [], skipped: [] };
  mkdirSync(targetDir, { recursive: true });
  for (const skill of readdirSync(source)) {
    const dest = join(targetDir, skill);
    if (existsSync(dest) && !existsSync(join(dest, MARKER))) {
      result.skipped.push(skill); // someone else's skill with the same name
      continue;
    }
    rmSync(dest, { recursive: true, force: true });
    cpSync(join(source, skill), dest, { recursive: true });
    writeFileSync(join(dest, MARKER), "Installed by `artifact install-skills`. Reinstalled on update; removed by `artifact uninstall`.\n");
    result.installed.push(skill);
  }
  return result;
}

export function uninstallSkills(targetDir: string): string[] {
  if (!existsSync(targetDir)) return [];
  const removed: string[] = [];
  for (const skill of readdirSync(bundledSkillsDir())) {
    const dest = join(targetDir, skill);
    if (existsSync(join(dest, MARKER))) {
      rmSync(dest, { recursive: true, force: true });
      removed.push(skill);
    }
  }
  return removed;
}
