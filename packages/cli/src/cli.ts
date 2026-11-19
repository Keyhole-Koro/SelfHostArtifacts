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
import { activity, comment, comments, formatActivity, formatComments, labels, list, loginLink, move, projects, publish, read, reindex, remove, search, secretDelete, secretList, secretRequest, secretSend, secretShare, secretStatus } from "./operations.ts";
import type { KeySelection } from "./secret.ts";
import { ALLOWED_COMMANDS, vaultCollections, vaultCreate, vaultDestroy, vaultDevices, vaultGrant, vaultInit, vaultKey, vaultLedger, vaultPut, vaultRecover, vaultRevoke, vaultRotate, vaultSecret, vaultSecrets, vaultUse, type ValueSink, type ValueSource } from "./vault.ts";
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
      --parent <url>                Put the page under another page, in that page's project
      --labels <a,b>                Set the page's labels (left out: they stay)
  artifact list [--limit n] [--project <name> | --none] [--label <label>]
  artifact labels <url> [add|remove <label>...]
                                    A page's labels, or add and remove some
  artifact projects                 Projects and how many pages each has
  artifact comments <url> [--all]   Open comment threads on a page (--all: settled ones too)
  artifact comment <url> <text…> [--reply-to <id>] [--resolve]
                                    Comment on a page, or reply in a thread and settle it
  artifact activity [--project <name>] [--limit n]
                                    What changed lately: new pages, changes, comments
  artifact reindex                  Send every page's text and links again, for search (no new versions)
  artifact search <words…> [--limit n]
                                    Pages whose title or text has every word; label:<name> narrows to a label
  artifact move <url> <project>     Move a page, with the pages under it, to another project (--none: out of any project)
  artifact move <url> --parent <url|top> [--position n]
                                    Put a page under another page of its project, or at the top, at place n
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

Vault (secrets only this computer's key and the owner's key can open)
  artifact vault init               Make this computer's key and the owner key; prints the recovery key once
  artifact vault key                Make (if needed) and show this computer's key fingerprint
  artifact vault devices            Computers with a vault key, with fingerprints
  artifact vault create <collection>
  artifact vault list [collection]  Collections, or the secrets of one (names and the ledger, never values)
  artifact vault show <collection> <name>              Versions of a secret
  artifact vault put <collection> <name> (--from <file> | --generate [--bytes n] | --stdin)
      [--description <d>] [--used-by <what reads it>]  Encrypt a value here and store it as a new version
  artifact vault use <collection> <name> (--out <file> | --run -- <gcloud|gh|wrangler|circleci> args… | --reveal) [--version n]
                                    Open a value and write it to a 0600 file, pipe it into a command, or print it
  artifact vault ledger <collection> <name> [--description <d>] [--used-by <w>]
  artifact vault grant <collection> <device>           Let another computer read (compare its fingerprint first)
  artifact vault revoke <collection> <device>          Take that away and replace the collection key
  artifact vault rotate <collection>                   Replace the collection key (after a device was lost)
  artifact vault destroy <collection> <name> [--version n]
                                    Destroy one version's value, or the whole secret
  artifact vault recover (--recovery-key <k> | --recovery-key-file <f>)
                                    With the recovery key, let this computer read every collection

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
      labels: { type: "string" },
      hours: { type: "string" },
      key: { type: "string", multiple: true },
      project: { type: "string" },
      parent: { type: "string" },
      position: { type: "string" },
      none: { type: "boolean" },
      all: { type: "boolean" },
      "reply-to": { type: "string" },
      resolve: { type: "boolean" },
      from: { type: "string" },
      generate: { type: "boolean" },
      bytes: { type: "string" },
      stdin: { type: "boolean" },
      out: { type: "string" },
      run: { type: "boolean" },
      reveal: { type: "boolean" },
      "used-by": { type: "string" },
      "recovery-key": { type: "string" },
      "recovery-key-file": { type: "string" },
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
        parent: o.parent,
        labels: o.labels === undefined ? undefined : o.labels.split(/[,\s]+/).filter(Boolean),
      });
      out(`${r.created ? "Published" : "Updated"}: ${r.url} (version ${r.version}, private${r.project ? `, in ${r.project}` : ""})`, r);
      return;
    }

    case "list": {
      const r = await list(o.limit ? Number(o.limit) : 25, o.none ? null : o.project, o.label);
      out(
        r.artifacts
          .map((a) => `${a.url}  v${a.version}  ${a.project ? `[${a.project}] ` : ""}${a.title}${a.labels?.length ? `  #${a.labels.join(" #")}` : ""}`)
          .join("\n") || "Nothing here.",
        r,
      );
      return;
    }

    case "labels": {
      const [url, verb, ...words] = rest;
      if (!url || (verb !== undefined && verb !== "add" && verb !== "remove") || (verb && words.length === 0)) {
        throw new ArtifactError("Usage: artifact labels <url> [add|remove <label>...]", "bad_args");
      }
      const list = words.flatMap((w) => w.split(",")).filter(Boolean);
      const r = await labels(url, verb === "add" ? { add: list } : verb === "remove" ? { remove: list } : {});
      out(r.labels.length ? r.labels.join(" ") : "No labels.", r);
      return;
    }

    case "comments": {
      const url = rest[0];
      if (!url) throw new ArtifactError("Usage: artifact comments <url> [--all]", "bad_args");
      const r = await comments(url);
      out(formatComments(r.comments, !!o.all) || "No open comments.", r);
      return;
    }

    case "comment": {
      const url = rest[0];
      const text = rest.slice(1).join(" ").trim();
      if (!url || !text) throw new ArtifactError("Usage: artifact comment <url> <text…> [--reply-to <id>] [--resolve]", "bad_args");
      const r = await comment(url, { body: text, ...(o["reply-to"] ? { reply_to: o["reply-to"] } : {}), ...(o.resolve ? { resolve: true } : {}) });
      out(`Commented: ${r.url}`, r);
      return;
    }

    case "activity": {
      const r = await activity(o.project, o.limit ? Number(o.limit) : 30);
      out(formatActivity(r.activity) || "Nothing happened yet.", r);
      return;
    }

    case "reindex": {
      const r = await reindex((title, result) => console.error(`  ${title}: ${result}`));
      out(`Sent the text of ${r.updated} of ${r.pages} pages. They are searchable now, and by meaning within a minute.`, r);
      return;
    }

    case "search": {
      const query = rest.join(" ").trim();
      if (!query) throw new ArtifactError("Usage: artifact search <words…>", "bad_args");
      const r = await search(query, o.limit ? Number(o.limit) : 20);
      out(r.results.map((h) => `${h.url}  ${h.project ? `[${h.project}] ` : ""}${h.title}${h.match === "meaning" ? "  (by meaning)" : ""}\n    ${h.snippet.replace(/\s+/g, " ")}`).join("\n") || "No page matches.", r);
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
      const position = o.position === undefined ? undefined : Number(o.position);
      if (!url || (name === undefined && o.parent === undefined && position === undefined) || (position !== undefined && !(position >= 1))) {
        throw new ArtifactError("Usage: artifact move <url> <project> | --none | --parent <url|top> [--position n]", "bad_args");
      }
      const r = await move(url, {
        ...(name !== undefined ? { project: name } : {}),
        ...(o.parent !== undefined ? { parent: o.parent === "top" ? null : o.parent } : {}),
        ...(position !== undefined ? { position } : {}),
      });
      const where = r.project ? `in ${r.project}` : "without a project";
      out(`Now ${where}${r.parent ? `, under ${r.parent}` : ", at the top"}, place ${r.position}.`, r);
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

    case "vault": {
      const [sub, a, b, ...more] = rest;
      const versionOf = () => (o.version ? Number(o.version) : undefined);
      switch (sub) {
        case "init": {
          const r = await vaultInit();
          const device = `This computer: member ${r.device.member_id}, key fingerprint ${r.device.fingerprint} (kept in the ${r.device.store === "keyring" ? "OS keyring" : "profile directory"}).`;
          if (r.owner_existed) {
            out(`${device}\nThe vault already had an owner key; nothing else to do.`, r);
          } else {
            out(
              `${device}\n\nRecovery key (shown only now; put it in a password manager or on paper — without it, losing every computer loses every secret):\n\n  ${r.recovery_key}\n`,
              r,
            );
          }
          return;
        }
        case "key": {
          const r = await vaultKey();
          out(`This computer: member ${r.member_id}, key fingerprint ${r.fingerprint} (${r.store === "keyring" ? "OS keyring" : "file in the profile directory"}).`, r);
          return;
        }
        case "devices": {
          const r = await vaultDevices();
          out(r.map((m) => `${m.id}  ${m.kind === "owner" ? "owner" : (m.device_name ?? m.device_id ?? "")}${m.revoked_at ? "  (revoked)" : ""}  ${m.fingerprint}`).join("\n") || "No vault keys yet. Run `artifact vault init`.", r);
          return;
        }
        case "create": {
          if (!a) throw new ArtifactError("Usage: artifact vault create <collection>", "bad_args");
          const r = await vaultCreate(a);
          out(`Created collection ${r.name}. This computer and the owner key can open it; \`artifact vault grant ${r.name} <device>\` adds another computer.`, r);
          return;
        }
        case "list": {
          if (a) {
            const r = await vaultSecrets(a);
            out(
              r.secrets.map((x) => `${x.name}  v${x.current_version}  ${x.updated_at.slice(0, 10)}  ${x.description ?? ""}${x.used_by ? `  [${x.used_by}]` : ""}`).join("\n") || `${r.collection} has no secrets yet.`,
              r,
            );
          } else {
            const r = await vaultCollections();
            out(r.collections.map((x) => `${x.name}  ${x.secrets} secret${x.secrets === 1 ? "" : "s"}  ${x.members} reader${x.members === 1 ? "" : "s"}  ${x.readable ? "readable here" : "not readable here"}`).join("\n") || "No collections yet. `artifact vault create <name>` makes one.", r);
          }
          return;
        }
        case "show": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault show <collection> <name>", "bad_args");
          const r = await vaultSecret(a, b);
          out(
            `${r.collection}/${r.name}  v${r.current_version}${r.description ? `  ${r.description}` : ""}${r.used_by ? `\nUsed by: ${r.used_by}` : ""}\n` +
              r.versions.map((v) => `  v${v.version}  ${v.created_at}  by ${v.created_by}${v.destroyed_at ? `  destroyed ${v.destroyed_at}` : ""}`).join("\n"),
            r,
          );
          return;
        }
        case "put": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault put <collection> <name> (--from <file> | --generate [--bytes n] | --stdin) [--description <d>] [--used-by <w>]", "bad_args");
          let source: ValueSource;
          if (o.from) source = { file: o.from };
          else if (o.generate) source = { generate: o.bytes ? Number(o.bytes) : 0 };
          else if (o.stdin) source = { value: (await readStdin()).replace(/\r?\n$/, "") };
          else throw new ArtifactError("Say where the value comes from: --from <file>, --generate, or --stdin. Do not pass the value as an argument.", "bad_args");
          const r = await vaultPut(a, b, source, { ...(o.description !== undefined ? { description: o.description } : {}), ...(o["used-by"] !== undefined ? { usedBy: o["used-by"] } : {}) });
          out(`Stored ${r.collection}/${r.name} as version ${r.version} (${r.bytes} bytes${r.generated ? ", generated" : ""}).`, r);
          return;
        }
        case "use": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault use <collection> <name> (--out <file> | --run -- <command…> | --reveal) [--version n]", "bad_args");
          let sink: ValueSink;
          if (o.out) sink = { file: o.out };
          else if (o.run) sink = { command: more };
          else if (o.reveal) sink = { reveal: true };
          else throw new ArtifactError(`Say where the value goes: --out <file>, --run -- <${ALLOWED_COMMANDS.join("|")} …>, or --reveal (prints it).`, "bad_args");
          const r = await vaultUse(a, b, sink, versionOf());
          if ("value" in r.delivered) {
            if (o.json) out("", r);
            else process.stdout.write(r.delivered.value + (process.stdout.isTTY ? "\n" : ""));
          } else if ("file" in r.delivered) {
            out(`Wrote ${r.collection}/${r.name} v${r.version} to ${r.delivered.file} (0600).`, r);
          } else {
            out(`Piped ${r.collection}/${r.name} v${r.version} into ${r.delivered.command}.${r.delivered.stdout.trim() ? `\n${r.delivered.stdout.trim()}` : ""}`, r);
          }
          return;
        }
        case "ledger": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault ledger <collection> <name> [--description <d>] [--used-by <w>]", "bad_args");
          const r = await vaultLedger(a, b, { ...(o.description !== undefined ? { description: o.description } : {}), ...(o["used-by"] !== undefined ? { usedBy: o["used-by"] } : {}) });
          out(`${r.name}: ${r.description ?? "(no description)"}${r.used_by ? ` — used by ${r.used_by}` : ""}`, r);
          return;
        }
        case "grant": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault grant <collection> <device name | member id>", "bad_args");
          const r = await vaultGrant(a, b);
          out(`${r.member.device_name ?? r.member.id} can now open ${r.collection}. Its key fingerprint is ${r.member.fingerprint}; \`artifact vault key\` on that computer must show the same digits.`, r);
          return;
        }
        case "revoke": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault revoke <collection> <device name | member id>", "bad_args");
          const r = await vaultRevoke(a, b);
          out(`${r.removed ? "Removed" : "There was no grant for"} ${r.member} on ${r.collection}, and replaced the collection key (version ${r.key_version}, ${r.members} readers, ${r.versions} versions re-wrapped). Values that computer could read should be changed too.`, r);
          return;
        }
        case "rotate": {
          if (!a) throw new ArtifactError("Usage: artifact vault rotate <collection>", "bad_args");
          const r = await vaultRotate(a);
          out(`Replaced the key of ${r.collection} (version ${r.key_version}): ${r.members} readers, ${r.versions} versions re-wrapped.`, r);
          return;
        }
        case "destroy": {
          if (!a || !b) throw new ArtifactError("Usage: artifact vault destroy <collection> <name> [--version n]", "bad_args");
          const r = await vaultDestroy(a, b, versionOf());
          out(r.deleted ? `Deleted ${a}/${b} and all its versions.` : r.destroyed ? `Destroyed version ${r.version} of ${a}/${b}.` : `Version ${r.version} was already destroyed.`, r);
          return;
        }
        case "recover": {
          let recoveryKey = o["recovery-key"];
          if (!recoveryKey && o["recovery-key-file"]) recoveryKey = (await import("node:fs")).readFileSync(o["recovery-key-file"], "utf8").trim();
          if (!recoveryKey && !process.stdin.isTTY) recoveryKey = (await readStdin()).trim();
          if (!recoveryKey) throw new ArtifactError("Usage: artifact vault recover --recovery-key <key> (or --recovery-key-file <file>, or the key on standard input)", "bad_args");
          const r = await vaultRecover(recoveryKey);
          out(r.collections.length ? `This computer can now open: ${r.collections.join(", ")}.` : "This computer could already open every collection.", r);
          return;
        }
        default:
          throw new ArtifactError("Usage: artifact vault init|key|devices|create|list|show|put|use|ledger|grant|revoke|rotate|destroy|recover. Run `artifact help`.", "bad_args");
      }
    }

    default:
      throw new ArtifactError(`Unknown command "${command}". Run \`artifact help\`.`, "bad_args");
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", reject);
  });
}

main().catch((e: unknown) => {
  const message = e instanceof ArtifactError || (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? (e as Error).message : String((e as Error).stack ?? e);
  console.error(message);
  process.exit(1);
});
