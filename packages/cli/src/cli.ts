import { parseArgs } from "node:util";
import { ArtifactError } from "./client.ts";
import { login, openBrowser } from "./commands/login.ts";
import {
  AGENTS,
  detectAgents,
  installSkills,
  registerMcp,
  serverName,
  skillDirsFor,
  uninstallSkills,
  unregisterMcp,
  type Agent,
} from "./commands/setup.ts";
import { serveMcp } from "./mcp.ts";
import { list, loginLink, publish, read, remove } from "./operations.ts";
import { loadConfig, originFor, profileDir } from "./profile.ts";
import { VERSION } from "./version.ts";

const HELP = `artifact ${VERSION} — publish private HTML pages to your own deployment

Setup
  artifact setup --host <host>      Log in, register the MCP server with Codex / Gemini CLI / Claude Code, install skills
  artifact login --host <host>      Pair this computer (opens the browser for approval)
  artifact status                   Show the deployment and device of this profile
  artifact open [url]               Sign the browser in with this computer's key and open the site (or a page)
  artifact install-skills           (Re)install the skills
  artifact uninstall                Remove the MCP registrations and skills

Pages
  artifact publish <file.html|dir>  Publish; publishing the same file again updates the same URL
      --title <t> --description <d> --url <page url> --file <published=local> --allow-connect <host>
  artifact list [--limit n]
  artifact read <url> [path] [--version n]
  artifact delete <url>             Move to the trash (restorable for 30 days)

Agents
  artifact mcp                      Run the stdio MCP server (agents start this themselves)

Options
  --profile <name>   Use another profile (separate deployment or device key)
  --agent <a,b>      Limit setup/install-skills/uninstall to codex, gemini, claude
  --json             Machine-readable output
`;

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      name: { type: "string" },
      profile: { type: "string" },
      agent: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      file: { type: "string", multiple: true },
      "allow-connect": { type: "string", multiple: true },
      limit: { type: "string" },
      version: { type: "string" },
      json: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "skip-login": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function agentsFrom(option: string | undefined, fallback: Agent[]): Agent[] {
  if (!option) return fallback;
  const picked = option.split(",").map((a) => a.trim()) as Agent[];
  for (const a of picked) if (!AGENTS.includes(a)) throw new ArtifactError(`Unknown agent "${a}". Use ${AGENTS.join(", ")}.`, "bad_agent");
  return picked;
}

function filesFrom(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const files: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new ArtifactError(`--file takes published=local, e.g. --file css/site.css=./site.css (got "${pair}")`, "bad_args");
    files[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return files;
}

async function main(): Promise<void> {
  const { values: o, positionals } = parse();
  if (o.profile) process.env["ARTIFACT_PROFILE"] = o.profile;
  const [command, ...rest] = positionals;
  const out = (human: string, json: unknown) => console.log(o.json ? JSON.stringify(json, null, 2) : human);

  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return;

    case "version":
      console.log(VERSION);
      return;

    case "mcp":
      await serveMcp();
      return;

    case "login":
      await login({ host: o.host, name: o.name, browser: !o["no-browser"] });
      return;

    case "setup": {
      if (!o["skip-login"]) await login({ host: o.host, name: o.name, browser: !o["no-browser"] });
      const agents = agentsFrom(o.agent, detectAgents());
      if (agents.length === 0) {
        console.log("\nNo Codex, Gemini CLI or Claude Code found on PATH. Install one and run `artifact setup --skip-login` again.");
        return;
      }
      console.log("");
      for (const agent of agents) {
        const r = registerMcp(agent);
        console.log(r.ok ? `✓ ${agent}: MCP server "${serverName()}" registered` : `✗ ${agent}: could not register the MCP server\n  ${r.output}`);
      }
      for (const dir of skillDirsFor(agents)) {
        const r = installSkills(dir);
        if (r.removedLegacy.length) console.log(`✓ removed old skill names ${r.removedLegacy.join(", ")} from ${dir}`);
        if (r.installed.length) console.log(`✓ skills ${r.installed.join(", ")} → ${dir}`);
        for (const s of r.skipped) console.log(`! ${dir}/${s} exists and was not installed by artifact; left as is`);
      }
      console.log("\nRestart your agents so they pick up the new MCP server and skills.");
      return;
    }

    case "install-skills": {
      for (const dir of skillDirsFor(agentsFrom(o.agent, AGENTS))) {
        const r = installSkills(dir);
        if (r.removedLegacy.length) console.log(`✓ removed old skill names ${r.removedLegacy.join(", ")} from ${dir}`);
        console.log(`✓ ${r.installed.join(", ") || "nothing"} → ${dir}`);
        for (const s of r.skipped) console.log(`! ${dir}/${s} exists and was not installed by artifact; left as is`);
      }
      return;
    }

    case "uninstall": {
      const agents = agentsFrom(o.agent, detectAgents());
      for (const agent of agents) {
        const r = unregisterMcp(agent);
        console.log(r.ok ? `✓ ${agent}: MCP server removed` : `- ${agent}: ${r.output || "not registered"}`);
      }
      for (const dir of skillDirsFor(agentsFrom(o.agent, AGENTS))) {
        const removed = uninstallSkills(dir);
        if (removed.length) console.log(`✓ removed ${removed.join(", ")} from ${dir}`);
      }
      console.log(`Your device key is still in ${profileDir()}. Revoke the device in Settings and delete that folder to remove it.`);
      return;
    }

    case "open": {
      const link = await loginLink(rest[0]);
      if (!o["no-browser"]) openBrowser(link);
      out(`Opening ${link}\n(works once, for two minutes)`, { url: link });
      return;
    }

    case "status": {
      const config = loadConfig();
      if (!config) {
        out("Not set up. Run `artifact setup --host <host>`.", { configured: false });
        return;
      }
      out(
        `Deployment: ${originFor(config.host)}\nDevice: ${config.device_name ?? "?"} (${config.device_id ?? "not logged in"})\nProfile: ${profileDir()}`,
        { configured: true, origin: originFor(config.host), ...config },
      );
      return;
    }

    case "publish": {
      const target = rest[0];
      if (!target) throw new ArtifactError("Usage: artifact publish <file.html|dir>", "bad_args");
      const r = await publish({
        filePath: target,
        files: filesFrom(o.file),
        title: o.title,
        description: o.description,
        url: o.url,
        allowConnect: o["allow-connect"],
      });
      out(`${r.created ? "Published" : "Updated"}: ${r.url} (version ${r.version}, private)`, r);
      return;
    }

    case "list": {
      const r = await list(o.limit ? Number(o.limit) : 25);
      out(r.artifacts.map((a) => `${a.url}  v${a.version}  ${a.title}`).join("\n") || "Nothing is published yet.", r);
      return;
    }

    case "read": {
      const url = rest[0];
      if (!url) throw new ArtifactError("Usage: artifact read <url> [path]", "bad_args");
      const r = await read(url, rest[1], o.version ? Number(o.version) : undefined);
      if (o.json) out("", { path: r.path, version: r.version, text: r.text, saved_to: r.savedTo });
      else process.stdout.write(r.text ?? `Binary file saved to ${r.savedTo}\n`);
      return;
    }

    case "delete": {
      const url = rest[0];
      if (!url) throw new ArtifactError("Usage: artifact delete <url>", "bad_args");
      const r = await remove(url);
      out(`Moved to the trash. Restore it at ${r.restore}`, r);
      return;
    }

    default:
      throw new ArtifactError(`Unknown command "${command}". Run \`artifact help\`.`, "bad_args");
  }
}

main().catch((e: unknown) => {
  const message = e instanceof ArtifactError || (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? (e as Error).message : String((e as Error).stack ?? e);
  console.error(message);
  process.exit(1);
});
