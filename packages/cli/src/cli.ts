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
import { describeSecret, serveMcp } from "./mcp.ts";
import { list, loginLink, move, projects, publish, read, remove, secretDelete, secretList, secretRequest, secretSend, secretShare, secretStatus } from "./operations.ts";
import type { KeySelection } from "./secret.ts";
import { loadConfig, originFor, profileDir } from "./profile.ts";
import { VERSION } from "./version.ts";

const HELP = `artifact ${VERSION} — publish private HTML pages to your own deployment

Setup
  artifact setup --host <host>      Log in, register the MCP server with Codex / Gemini CLI / Claude Code, install skills
  artifact login --host <host>      Pair this computer (opens the browser for approval)
  artifact status                   Show the deployment and device of this profile
  artifact open [url]               Open a view-only browser session with this computer's key
  artifact install-skills           (Re)install the skills
  artifact uninstall                Remove the MCP registrations and skills

Pages
  artifact publish <file.html|dir>  Publish; publishing the same file again updates the same URL
      --title <t> --description <d> --url <page url> --file <published=local> --allow-connect <host>
      --project <name>              A new page goes into the project named after this git repository unless given
  artifact list [--limit n] [--project <name> | --none]
  artifact projects                 Projects and how many pages each has
  artifact move <url> <project>     Move a page to another project (--none: out of any project)
  artifact read <url> [path] [--version n]
  artifact delete <url>             Move to the trash (restorable for 30 days)

Secrets (only the recipient's browser can decrypt)
  artifact secret share <file> --label <l> [--key NAME[=Shown name]]... [--hours n]
                                    Encrypt values now and print a link; the first browser that opens it reads them
  artifact secret request --label <l> [--hours n]   Make a link for the recipient (72 h by default, at most 168)
  artifact secret status [id]                       Who opened it and the key fingerprint; without id, recent requests
  artifact secret send <id> <file> [--key NAME[=Shown name]]...
                                    Encrypt values from a .env, JSON or text file and send them
  artifact secret delete <id>                       End the request and delete the ciphertext

Agents
  artifact mcp                      Run the stdio MCP server (agents start this themselves)

Options
  --profile <name>   Use another profile (separate deployment or device key)
  --agent <a,b>      Limit setup/install-skills/uninstall to codex, gemini, claude
  --json             Machine-readable output
  --browser <name>   Browser for login and open: chrome, firefox, edge, safari, a command, or none
                     (default: $ARTIFACT_BROWSER, then $BROWSER, then the system default)
  --no-browser       Only print the URL
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
      browser: { type: "string" },
      "skip-login": { type: "boolean" },
      label: { type: "string" },
      hours: { type: "string" },
      key: { type: "string", multiple: true },
      project: { type: "string" },
      none: { type: "boolean" },
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

/** --key NAME keeps the name; --key NAME=Shown name renames it. */
function keysFrom(keys: string[] | undefined): KeySelection | undefined {
  if (!keys?.length) return undefined;
  if (keys.every((k) => !k.includes("="))) return keys;
  const out: Record<string, string> = {};
  for (const k of keys) {
    const eq = k.indexOf("=");
    out[eq < 0 ? k : k.slice(0, eq)] = eq < 0 ? k : k.slice(eq + 1);
  }
  return out;
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
      await login({ host: o.host, name: o.name, browser: !o["no-browser"], browserChoice: o.browser });
      return;

    case "setup": {
      if (!o["skip-login"]) await login({ host: o.host, name: o.name, browser: !o["no-browser"], browserChoice: o.browser });
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
      if (!o["no-browser"]) openBrowser(link, o.browser);
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
        project: o.project,
      });
      out(`${r.created ? "Published" : "Updated"}: ${r.url} (version ${r.version}, private${r.project ? `, in ${r.project}` : ""})`, r);
      return;
    }

    case "list": {
      const r = await list(o.limit ? Number(o.limit) : 25, o.none ? null : o.project);
      out(r.artifacts.map((a) => `${a.url}  v${a.version}  ${a.project ? `[${a.project}] ` : ""}${a.title}`).join("\n") || "Nothing here.", r);
      return;
    }

    case "projects": {
      const r = await projects();
      out(r.projects.map((p) => `${String(p.count).padStart(4)}  ${p.project ?? "(no project)"}`).join("\n") || "Nothing is published yet.", r);
      return;
    }

    case "move": {
      const url = rest[0];
      const name = o.none ? null : (rest[1] ?? o.project);
      if (!url || name === undefined) throw new ArtifactError("Usage: artifact move <url> <project>, or artifact move <url> --none", "bad_args");
      const r = await move(url, name);
      out(r.project ? `Moved to ${r.project}.` : "Now without a project.", r);
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

    case "secret": {
      const [sub, id, file] = rest;
      switch (sub) {
        case "request": {
          if (!o.label) throw new ArtifactError("Usage: artifact secret request --label <what it is> [--hours n]", "bad_args");
          const r = await secretRequest(o.label, o.hours ? Number(o.hours) : undefined);
          out(`Request ${r.id}. Give this link to the recipient:\n${r.url}\nIt works until ${r.expires_at}.`, r);
          return;
        }
        case "share": {
          const path = id;
          if (!path || !o.label) throw new ArtifactError("Usage: artifact secret share <file> --label <what it is> [--key NAME[=Shown name]]... [--hours n]", "bad_args");
          const r = await secretShare(o.label, path, keysFrom(o.key), o.hours ? Number(o.hours) : undefined);
          out(
            `Share link ${r.id} (${r.names.join(", ")}). Give this whole link, including the part after #, to the recipient:\n${r.url}\n` +
              `The first browser that opens it and presses Show is the only one that can read it. It works until ${r.expires_at}.`,
            r,
          );
          return;
        }
        case "status": {
          if (!id) {
            const r = await secretList(o.limit ? Number(o.limit) : 25);
            out(r.secrets.map((x) => `${x.id}  ${x.status.padEnd(8)}  ${x.label}`).join("\n") || "No secret requests yet.", r);
            return;
          }
          const r = await secretStatus(id);
          out(describeSecret(r), r);
          return;
        }
        case "send": {
          if (!id || !file) throw new ArtifactError("Usage: artifact secret send <id> <file> [--key NAME[=Shown name]]...", "bad_args");
          const r = await secretSend(id, file, keysFrom(o.key));
          out(`Sent ${r.names.join(", ")} to the browser with key fingerprint ${r.fingerprint}.`, r);
          return;
        }
        case "delete": {
          if (!id) throw new ArtifactError("Usage: artifact secret delete <id>", "bad_args");
          const r = await secretDelete(id);
          out(r.status === "deleted" ? "Deleted. The link no longer works." : `It had already ended (${r.status}).`, r);
          return;
        }
        default:
          throw new ArtifactError("Usage: artifact secret share|request|status|send|delete. Run `artifact help`.", "bad_args");
      }
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
