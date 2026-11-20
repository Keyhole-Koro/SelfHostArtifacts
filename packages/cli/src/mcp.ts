import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ArtifactError } from "./client.ts";
import { activity, comment, comments, formatActivity, formatComments, labels, list, move, publish, read, remove, search, secretDelete, secretList, secretRequest, secretSend, secretShare, secretStatus, type SecretState } from "./operations.ts";
import { ALLOWED_USES } from "./vault-command.ts";
import { formatPush, formatStatus, isPlaintextTarget, vaultPush, vaultStatus, vaultStatusAll, vaultTargetAdd, vaultTargetRemove, vaultTargets } from "./vault-push.ts";
import { ALLOWED_COMMANDS, vaultCollections, vaultCreate, vaultDestroy, vaultDevices, vaultGrant, vaultPut, vaultSecrets, vaultUse } from "./vault.ts";
import { VERSION } from "./version.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

/** Every failure becomes an MCP tool error whose text tells the agent what to do next. */
async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    const message = e instanceof ArtifactError ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { ...text(message), isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "artifact", version: VERSION });

  server.registerTool(
    "publish",
    {
      title: "Publish a page",
      description:
        "Publish a local HTML page as a private web page and return its URL. Publishing the same file_path again updates the same URL " +
        "(a new version). Pass url to update a page that was published from another file. A new page goes into the project named after the " +
        "git repository you are working in; pass project only to choose another. Read the selfhost-artifact-design skill before writing " +
        "the page. Never put secrets, credentials or personal data in a page.",
      inputSchema: {
        file_path: z.string().describe("Absolute path of the .html page, or of a folder that has an index.html (all its files are published)"),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe('Extra files as { "published/path": "/local/path" }: CSS, scripts, images, data'),
        title: z.string().optional().describe("Defaults to the page's <title>"),
        description: z.string().optional().describe("One sentence shown in the list of pages"),
        url: z.string().optional().describe("URL of an existing page to update"),
        allow_connect: z
          .array(z.string())
          .optional()
          .describe('Hostnames the page may fetch from, e.g. ["api.example.com"]. Only when the page needs live data from them'),
        project: z
          .string()
          .optional()
          .describe("Project to put the page in. Leave it out: a new page goes into the current git repository's project, an update stays where it is"),
        parent: z
          .string()
          .optional()
          .describe("URL of the page to put this one under, as a child page in that page's project. Use it to build a tree of related pages"),
        labels: z
          .array(z.string())
          .optional()
          .describe('Labels that group pages across projects, e.g. ["decision"]. They replace the page\'s labels; leave out to keep them'),
      },
    },
    ({ file_path, files, title, description, url, allow_connect, project, parent, labels: pageLabels }) =>
      run(async () => {
        const r = await publish({ filePath: file_path, files, title, description, url, allowConnect: allow_connect, project, parent, labels: pageLabels });
        const where = r.project ? `, in ${r.project}` : "";
        return `${r.created ? "Published" : "Updated"}: ${r.url} (version ${r.version}, private${where}; ${r.files} files, ${r.uploaded} uploaded)`;
      }),
  );

  server.registerTool(
    "read",
    {
      title: "Read a published page",
      description: "Read the published contents of a page: its entry HTML by default, or one of its files with path.",
      inputSchema: {
        url: z.string().describe("The page URL"),
        path: z.string().optional().describe("A file of the page, e.g. data.json"),
        version: z.number().int().positive().optional().describe("An older version; defaults to the latest"),
      },
    },
    ({ url, path, version }) =>
      run(async () => {
        const r = await read(url, path, version);
        const files = Object.keys(r.detail.versions.find((v) => v.version === r.version)?.files ?? {}).join(", ");
        const header = `${r.detail.title} — version ${r.version} of ${r.detail.version}. Files: ${files}\n--- ${r.path} ---\n`;
        return header + (r.text ?? `(binary file saved to ${r.savedTo})`);
      }),
  );

  server.registerTool(
    "list",
    {
      title: "List published pages",
      description: "List published pages, most recently updated first, optionally of one project or with one label.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        project: z.string().optional().describe("Only pages in this project"),
        label: z.string().optional().describe("Only pages with this label"),
      },
    },
    ({ limit, project, label }) =>
      run(async () => {
        const { artifacts } = await list(limit ?? 25, project, label);
        if (artifacts.length === 0) return label ? `No page labeled ${label}.` : project ? `No page in ${project}.` : "Nothing is published yet.";
        return artifacts
          .map(
            (a) =>
              `${a.title} — ${a.url} (v${a.version}, updated ${a.updated_at}${a.project ? `, ${a.project}` : ""}${a.labels?.length ? `, labels: ${a.labels.join(", ")}` : ""})${a.description ? `\n  ${a.description}` : ""}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "labels",
    {
      title: "A page's labels",
      description:
        "Read a page's labels, or add and remove some. Labels group pages across projects (\"decision\", \"draft\", \"template\"); " +
        "list with label, or search with label:<name>, finds the pages that have one.",
      inputSchema: {
        url: z.string().describe("The page URL"),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    ({ url, add, remove }) =>
      run(async () => {
        const r = await labels(url, { ...(add?.length ? { add } : {}), ...(remove?.length ? { remove } : {}) });
        return r.labels.length ? `Labels: ${r.labels.join(", ")}` : "No labels.";
      }),
  );

  server.registerTool(
    "activity",
    {
      title: "What changed lately",
      description: "New pages, changes and comments, newest first, everywhere or in one project. Use it to catch up before working on a project's pages.",
      inputSchema: {
        project: z.string().optional().describe("Only this project"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    ({ project, limit }) => run(async () => formatActivity((await activity(project, limit ?? 30)).activity) || "Nothing happened yet."),
  );

  server.registerTool(
    "comments",
    {
      title: "Read a page's comments",
      description:
        "The comment threads on a page: what people asked or noted, each on the whole page or on a quoted passage. " +
        "Settled threads are left out unless all is true. Reply with the comment tool, after changing the page if they asked for a change.",
      inputSchema: {
        url: z.string().describe("The page URL"),
        all: z.boolean().optional().describe("Include settled (resolved) threads"),
      },
    },
    ({ url, all }) =>
      run(async () => {
        const r = await comments(url);
        return formatComments(r.comments, !!all) || "No open comments.";
      }),
  );

  server.registerTool(
    "comment",
    {
      title: "Comment on a page",
      description:
        "Comment on a page, or reply in a thread (reply_to: the id in brackets that the comments tool shows). With resolve, the thread is " +
        "settled after the reply: use it when you did what the thread asked.",
      inputSchema: {
        url: z.string().describe("The page URL"),
        body: z.string().describe("The comment"),
        reply_to: z.string().optional().describe("The thread to reply in"),
        quote: z.string().optional().describe("For a new thread: the passage of the page it is about, as it appears there"),
        resolve: z.boolean().optional().describe("With reply_to: settle the thread"),
      },
    },
    ({ url, body, reply_to, quote, resolve }) =>
      run(async () => {
        const r = await comment(url, { body, ...(reply_to ? { reply_to } : {}), ...(quote ? { quote } : {}), ...(resolve ? { resolve } : {}) });
        return `Commented: ${r.url}`;
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search pages",
      description:
        "Find published pages by their words (every word of the query, any part of a word, Japanese included) and by meaning " +
        "(pages that say something close in other words, marked \"by meaning\"). label:<name> in the query keeps only pages with that " +
        "label. Use it before writing a page, to link to what exists instead of repeating it.",
      inputSchema: {
        query: z.string().describe("Words to find, separated by spaces"),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    ({ query, limit }) =>
      run(async () => {
        const { results } = await search(query, limit ?? 20);
        if (results.length === 0) return "No page has every one of these words.";
        return results
          .map((h) => `${h.title} — ${h.url}${h.project ? ` (${h.project})` : ""}${h.match === "meaning" ? " [by meaning]" : ""}\n  ${h.snippet.replace(/\s+/g, " ")}`)
          .join("\n");
      }),
  );

  server.registerTool(
    "move",
    {
      title: "Move a page",
      description:
        "Move a page without making a new version: to another project (the pages under it go along; null for none), under another page " +
        "of its project (parent; null for the top), or to a place among its siblings (position, from 1).",
      inputSchema: {
        url: z.string().describe("The page URL"),
        project: z.string().nullable().optional().describe("Another project, or null for none"),
        parent: z.string().nullable().optional().describe("URL of the page to put it under, or null for the top of its project"),
        position: z.number().int().positive().optional().describe("Its place among the pages with the same parent, from 1"),
      },
    },
    ({ url, project, parent, position }) =>
      run(async () => {
        const r = await move(url, { project, parent, position });
        const where = r.project ? `in ${r.project}` : "without a project";
        return `Now ${where}${r.parent ? `, under ${r.parent}` : ", at the top"}, place ${r.position}.`;
      }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete a page",
      description:
        "Move a page to the trash; the owner can restore it from Settings for 30 days. Only do this when the user asked for this page to be deleted.",
      inputSchema: { url: z.string() },
      annotations: { destructiveHint: true },
    },
    ({ url }) =>
      run(async () => {
        const r = await remove(url);
        return `Moved to the trash. It can be restored at ${r.restore}`;
      }),
  );

  // --- The vault: values are opened only on this computer and go to a file or a command, never into the conversation ---

  server.registerTool(
    "vault_list",
    {
      title: "List vault collections, or the secrets of one",
      description:
        "The vault keeps secrets (API keys, passwords) encrypted so that only this computer's key and the owner's key can open them. " +
        "Without `collection`, lists the collections and whether this computer can read each. With it, lists that collection's " +
        "secrets: names, descriptions, what uses them, and versions. Values are never returned.",
      inputSchema: { collection: z.string().optional().describe("A collection name, e.g. medishare-prod") },
      annotations: { readOnlyHint: true },
    },
    ({ collection }) =>
      run(async () => {
        if (collection) {
          const r = await vaultSecrets(collection);
          if (!r.secrets.length) return `${r.collection} has no secrets yet.`;
          return r.secrets.map((x) => `${x.name} (v${x.current_version}, ${x.updated_at.slice(0, 10)})${x.description ? `: ${x.description}` : ""}${x.used_by ? ` — used by ${x.used_by}` : ""}`).join("\n");
        }
        const r = await vaultCollections();
        if (!r.collections.length) return "No collections yet. vault_create makes one (the user runs `artifact vault init` first, once).";
        return r.collections.map((x) => `${x.name}: ${x.secrets} secret(s), ${x.members} reader(s), ${x.readable ? "readable on this computer" : "NOT readable on this computer"}`).join("\n");
      }),
  );

  server.registerTool(
    "vault_create",
    {
      title: "Create a vault collection",
      description: "Make a collection (a group of secrets with the same readers, e.g. one per project and environment). This computer and the owner key can open it.",
      inputSchema: { name: z.string().describe("Letters, digits, - _ . — e.g. medishare-stg") },
    },
    ({ name }) =>
      run(async () => {
        const r = await vaultCreate(name);
        return `Created collection ${r.name}. Readers: this computer and the owner key. vault_grant adds another computer.`;
      }),
  );

  server.registerTool(
    "vault_put",
    {
      title: "Store a secret value in the vault",
      description:
        "Encrypt a value on this computer and store it as a new version of `name` in `collection`. The value comes from a local file " +
        "(`file_path`) or is generated here (`generate`: random bytes, base64url). Never write a secret value into the arguments or the " +
        "conversation. Say what uses it (`used_by`) so the ledger stays useful. Needs no read access to the collection.",
      inputSchema: {
        collection: z.string(),
        name: z.string().describe("Letters, digits, - _ . — e.g. RESEND_API_KEY"),
        file_path: z.string().optional().describe("Absolute path of a file whose whole content is the value (a trailing newline is dropped)"),
        generate: z.boolean().optional().describe("Make a new random value here instead of reading a file"),
        bytes: z.number().int().min(16).max(128).optional().describe("How many random bytes to generate (32 by default)"),
        description: z.string().optional().describe("What it is, one line"),
        used_by: z.string().optional().describe("What reads it, e.g. \"Cloud Run medishare-web (RESEND_API_KEY), CircleCI context medishare-prod\""),
      },
    },
    ({ collection, name, file_path, generate, bytes, description, used_by }) =>
      run(async () => {
        if (!file_path && !generate) throw new ArtifactError("Pass file_path (a file holding the value) or generate: true. Never pass the value itself.", "bad_args");
        const r = await vaultPut(collection, name, file_path ? { file: file_path } : { generate: bytes ?? 0 }, { ...(description !== undefined ? { description } : {}), ...(used_by !== undefined ? { usedBy: used_by } : {}) });
        return `Stored ${r.collection}/${r.name} as version ${r.version} (${r.bytes} bytes${r.generated ? ", generated" : ""}).`;
      }),
  );

  server.registerTool(
    "vault_use",
    {
      title: "Use a secret value without seeing it",
      description:
        "Open a vault value on this computer and pipe it into the standard input of a command that stores it where it is needed. " +
        "Only these uses are allowed; each word and flag is checked and anything else is refused:\n" +
        ALLOWED_USES.map((u) => `- ${u}`).join("\n") +
        "\nThe command runs without a shell, outside your project in an empty directory, with the tool's own login on this computer. " +
        "You get the exit status and the tool's short message, never the value: output that contains it is withheld. " +
        "Writing a value to a file is not available to you (a file is a plaintext copy you could read); if a tool really needs a file, " +
        "ask the user to run `artifact vault use <collection> <name> --out <path>` in a terminal. For a value that must reach the same " +
        "place again, prefer vault_target and vault_push. The read is recorded in the audit log.",
      inputSchema: {
        collection: z.string(),
        name: z.string(),
        version: z.number().int().min(1).optional().describe("A past version; the latest by default"),
        into: z
          .union([
            z.object({
              command: z
                .array(z.string())
                .min(1)
                .describe(`One of the allowed uses as words, e.g. ["gcloud", "secrets", "versions", "add", "resend-api-key", "--data-file=-", "--project", "my-project"]. First word: ${ALLOWED_COMMANDS.join(", ")}. The value goes to its standard input, never into an argument`),
            }),
            z.object({ file_path: z.string().describe("Not available to agents: refused, with what to ask the user instead") }),
          ])
          .describe("Where the value goes"),
      },
    },
    ({ collection, name, version, into }) =>
      run(async () => {
        if ("file_path" in into) {
          throw new ArtifactError(
            "vault_use does not write files for agents: a file is a plaintext copy that you, or anything you run, could read. Pipe the value " +
              `into one of the allowed commands instead, or, if a file is really needed, ask the user to run \`artifact vault use ${collection} ${name} --out ${into.file_path}\` in a terminal.`,
            "file_refused",
          );
        }
        const r = await vaultUse(collection, name, { command: into.command }, version);
        if (!("command" in r.delivered)) return `Opened ${r.collection}/${r.name} v${r.version}.`;
        const said = [r.delivered.stdout, r.delivered.stderr].filter(Boolean).join("\n");
        return `Piped ${r.collection}/${r.name} v${r.version} into ${r.delivered.command} (exit 0).${said ? `\n${said}` : ""}`;
      }),
  );

  server.registerTool(
    "vault_devices",
    {
      title: "Computers with a vault key",
      description: "Lists the computers (devices) that have a vault key, with each key's 12-digit fingerprint, and the owner key. Use it to find the device to pass to vault_grant.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const r = await vaultDevices();
        if (!r.length) return "No vault keys yet. The user runs `artifact vault init` once.";
        return r.map((m) => `${m.id}: ${m.kind === "owner" ? "owner key" : (m.device_name ?? m.device_id ?? "device")}${m.revoked_at ? " (revoked)" : ""} — fingerprint ${m.fingerprint}`).join("\n");
      }),
  );

  server.registerTool(
    "vault_grant",
    {
      title: "Let another computer read a collection",
      description:
        "Wrap the collection key for another computer that already has a vault key (it ran `artifact vault key`). Before calling this, " +
        "the user should compare the fingerprint shown by vault_devices with `artifact vault key` on that computer, so a key swapped on the server is noticed.",
      inputSchema: { collection: z.string(), device: z.string().describe("The device's name or vault member id (from vault_devices)") },
    },
    ({ collection, device }) =>
      run(async () => {
        const r = await vaultGrant(collection, device);
        return `${r.member.device_name ?? r.member.id} can now open ${r.collection}. Its key fingerprint is ${r.member.fingerprint}; \`artifact vault key\` on that computer must show the same digits.`;
      }),
  );

  server.registerTool(
    "vault_destroy",
    {
      title: "Destroy a secret value",
      description: "Destroy one version's value for good, or delete a whole secret with all its versions. Only when the user asks for it.",
      inputSchema: { collection: z.string(), name: z.string(), version: z.number().int().min(1).optional().describe("Destroy only this version; without it, the whole secret is deleted") },
      annotations: { destructiveHint: true },
    },
    ({ collection, name, version }) =>
      run(async () => {
        const r = await vaultDestroy(collection, name, version);
        return r.deleted ? `Deleted ${collection}/${name} and all its versions.` : r.destroyed ? `Destroyed version ${r.version} of ${collection}/${name}.` : `Version ${r.version} was already destroyed.`;
      }),
  );

  server.registerTool(
    "vault_status",
    {
      title: "Where each vault value has been delivered",
      description:
        "For each secret of a collection (or of every readable collection), its delivery targets and whether the current version arrived there: " +
        "delivered, STALE (an older version is there), NOT DELIVERED, or FAILED. Use it before vault_push, and to answer \"is X up to date in CircleCI?\".",
      inputSchema: { collection: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ collection }) =>
      run(async () => {
        if (collection) return formatStatus(await vaultStatus(collection));
        const all = await vaultStatusAll();
        return all.map((r) => `${r.collection}\n${formatStatus(r).split("\n").map((l) => `  ${l}`).join("\n")}`).join("\n\n") || "No readable collections.";
      }),
  );

  server.registerTool(
    "vault_target",
    {
      title: "Say where a vault value must be delivered",
      description:
        "Lists, adds or removes a secret's delivery targets. A target is `kind://address`: gcp://<project>/<secret id> (Secret Manager), " +
        "circleci://<gh|bb>/<org>/<context>/<VARIABLE>[?token=<collection>/<name>] (the token is itself a vault secret), " +
        "github://<owner>/<repo>/<NAME>[?environment=<env>], wrangler://<worker>/<NAME>[?config=…&cwd=…]. An envfile:///absolute/path/.env#KEY " +
        "target (a plaintext copy on this computer, which you could read) is added only by the user in a terminal. " +
        "Adding a target delivers nothing by itself: call vault_push.",
      inputSchema: {
        collection: z.string(),
        name: z.string(),
        add: z.string().optional().describe("A target address to add"),
        remove: z.string().optional().describe("A target address or id to remove"),
      },
    },
    ({ collection, name, add, remove }) =>
      run(async () => {
        if (add) {
          if (isPlaintextTarget(add)) {
            throw new ArtifactError(
              `${add.trim()} would leave a plaintext copy on this computer that you could read, so only the user adds it: ask them to run ` +
                `\`artifact vault target add ${collection} ${name} '${add.trim()}' --plaintext-ok\` in a terminal. vault_push keeps it up to date afterwards.`,
              "plaintext_refused",
            );
          }
          const t = await vaultTargetAdd(collection, name, add);
          return `${collection}/${name} will be delivered to ${t.address}. vault_push delivers it.`;
        }
        if (remove) {
          const r = await vaultTargetRemove(collection, name, remove);
          return r.removed ? `Removed ${r.address} from ${collection}/${name}; its delivery records stay.` : `${r.address} was already removed.`;
        }
        const targets = await vaultTargets(collection, name);
        return targets.map((t) => `${t.address}${t.delivered ? ` — v${t.delivered.version} delivered ${t.delivered.delivered_at}` : " — not delivered"}${t.plaintext_ok ? " [plaintext]" : ""}`).join("\n") || `${collection}/${name} has no targets.`;
      }),
  );

  server.registerTool(
    "vault_push",
    {
      title: "Deliver vault values to their targets",
      description:
        "Delivers each stale value of a collection (or of one secret) to its targets: a new Secret Manager version through gcloud, a CircleCI context " +
        "variable, a GitHub Actions secret through gh, a Worker secret through wrangler, or a KEY in a 0600 env file. Values are opened on this " +
        "computer and go only to the tool's standard input or an HTTPS body; nothing is returned to you. By default this only shows the plan; " +
        "pass apply: true when the user asked to deliver. Secret Manager deliveries are read back and compared. An env file is written only " +
        "if the user added that target on this computer.",
      inputSchema: {
        collection: z.string(),
        name: z.string().optional().describe("One secret; all of the collection by default"),
        apply: z.boolean().optional().describe("Actually deliver. Without it, only the plan is shown"),
        force: z.boolean().optional().describe("Deliver even where the current version is recorded as delivered"),
        only: z.array(z.enum(["gcp", "circleci", "github", "wrangler", "envfile"])).optional().describe("Only these kinds of targets"),
      },
      annotations: { destructiveHint: true },
    },
    ({ collection, name, apply, force, only }) =>
      run(async () => formatPush(await vaultPush(collection, { ...(name ? { name } : {}), dryRun: !apply, force: Boolean(force), ...(only ? { only } : {}) }))),
  );

  server.registerTool(
    "secret_share",
    {
      title: "Make a link that hands a secret to the first browser that opens it",
      description:
        "Hand a secret (a password, an API key) to someone in one step. Encrypts values from a local file here, stores only the " +
        "ciphertext, and returns a link whose key is after the # (browsers never send that part to the server). The first browser " +
        "that opens the link and presses Show reads the values; from then on no other browser can, even with the link. The file can be " +
        ".env (KEY=VALUE), JSON ({\"NAME\": \"value\"}) or any text file (one item). Never write a secret value into the arguments or " +
        "the conversation. The link itself lets whoever opens it first read the secret: give it only to the user to pass on, and " +
        "check secret_status afterwards to see who opened it. Prefer this to secret_request unless the user wants to compare key fingerprints.",
      inputSchema: {
        label: z.string().describe("What is being handed over, shown to the recipient (not secret), e.g. \"Mail passwords\""),
        file_path: z.string().describe("Absolute path of the file that holds the values"),
        keys: z
          .union([z.array(z.string()), z.record(z.string(), z.string())])
          .optional()
          .describe('Items to send: ["KEY", …] keeps the names; {"KEY": "Shown name"} renames them. All items by default'),
        expires_in_hours: z.number().int().min(1).max(168).optional().describe("How long the link works; 72 by default, at most 168"),
      },
    },
    ({ label, file_path, keys, expires_in_hours }) =>
      run(async () => {
        const r = await secretShare(label, file_path, keys, expires_in_hours);
        return (
          `Created share link ${r.id} ("${r.label}") with ${r.names.length} item${r.names.length === 1 ? "" : "s"} (${r.names.join(", ")}). ` +
          `Give this whole link, including the part after #, to the user to pass on: ${r.url}\n` +
          `It works until ${r.expires_at}. The first browser that opens it and presses Show is the only one that can read it.`
        );
      }),
  );

  server.registerTool(
    "secret_request",
    {
      title: "Ask for a secret handoff link",
      description:
        "Start handing a secret (a password, an API key) to someone. Returns a link for the recipient; the user sends it to them by any " +
        "channel. When they open it, their browser makes a key pair, and only that browser can decrypt what you send. Then check " +
        "secret_status and call secret_send. Never put a secret in a page or in the conversation; use this instead.",
      inputSchema: {
        label: z.string().describe("What is being handed over, shown to the recipient (not secret), e.g. \"Mail passwords\""),
        expires_in_hours: z.number().int().min(1).max(168).optional().describe("How long the link works; 72 by default, at most 168"),
      },
    },
    ({ label, expires_in_hours }) =>
      run(async () => {
        const r = await secretRequest(label, expires_in_hours);
        return (
          `Created secret request ${r.id} ("${r.label}"). Give this link to the recipient: ${r.url}\n` +
          `It works until ${r.expires_at}. The link alone never reveals the secret. After the recipient opens it, check secret_status, then call secret_send.`
        );
      }),
  );

  server.registerTool(
    "secret_status",
    {
      title: "Check a secret handoff",
      description:
        "Show whether the recipient has opened the link (when, from which IP and browser) and the fingerprint of their key. Without id, " +
        "list recent requests. Before secret_send, make sure the open looks like the intended person; if in doubt, ask the user to compare " +
        "the fingerprint with the 12 digits on the recipient's page.",
      inputSchema: { id: z.string().optional().describe("The request id from secret_request") },
    },
    ({ id }) =>
      run(async () => {
        if (!id) {
          const { secrets } = await secretList(25);
          if (secrets.length === 0) return "No secret requests yet.";
          return secrets.map((x) => `${x.id}  ${x.status}  ${x.label}  (created ${x.created_at}, expires ${x.expires_at})`).join("\n");
        }
        return describeSecret(await secretStatus(id));
      }),
  );

  server.registerTool(
    "secret_send",
    {
      title: "Send a secret to the recipient's browser",
      description:
        "Encrypt values from a local file for the recipient's browser and store only the ciphertext. The file can be .env (KEY=VALUE), " +
        "JSON ({\"NAME\": \"value\"}), or any text file (sent as one item). Never write a secret value into this tool's arguments or the " +
        "conversation: pass the file path, and keys to choose or rename items. The result lists names, never values. Works once per " +
        "request, after the recipient has opened the link (status claimed).",
      inputSchema: {
        id: z.string().describe("The request id from secret_request"),
        file_path: z.string().describe("Absolute path of the file that holds the values"),
        keys: z
          .union([z.array(z.string()), z.record(z.string(), z.string())])
          .optional()
          .describe('Items to send: ["KEY", …] keeps the names; {"KEY": "Shown name"} renames them. All items by default'),
      },
    },
    ({ id, file_path, keys }) =>
      run(async () => {
        const r = await secretSend(id, file_path, keys);
        return (
          `Sent ${r.names.length} item${r.names.length === 1 ? "" : "s"} (${r.names.join(", ")}) to the browser whose key fingerprint is ${r.fingerprint}. ` +
          "The recipient's page shows them now and deletes them from the server when they are done."
        );
      }),
  );

  server.registerTool(
    "secret_delete",
    {
      title: "Delete a secret request",
      description: "End a secret request and delete its ciphertext; the link stops working. Only when the user asks for it.",
      inputSchema: { id: z.string().describe("The request id") },
      annotations: { destructiveHint: true },
    },
    ({ id }) =>
      run(async () => {
        const r = await secretDelete(id);
        return r.status === "deleted" ? "Deleted. The link no longer works." : `It had already ended (${r.status}).`;
      }),
  );

  return server;
}

const NEXT_STEP: Record<string, string> = {
  waiting: "Nobody has opened the link yet. Make sure the recipient got it.",
  claimed: "Ready to send with secret_send.",
  sealed: "Sent; waiting for the recipient to finish.",
  received: "The recipient received it and deleted it from the server.",
  deleted: "Deleted.",
  expired: "Expired. Make a new request if it is still needed.",
};

const SHARE_NEXT_STEP: Record<string, string> = {
  waiting: "Nobody has pressed Show yet. Make sure the recipient got the whole link.",
  sealed: "Opened: only that browser can read it now. If that was not the recipient, delete it and make a new link.",
};

export function describeSecret(x: SecretState): string {
  const share = x.mode === "share";
  const lines = [`${x.label} — ${x.status}${share ? " (share link)" : ""}`, `Created ${x.created_at}, works until ${x.expires_at}`];
  if (x.claimed_at) lines.push(`Opened ${x.claimed_at} from ${x.claim_ip ?? "unknown IP"} (${x.claim_user_agent ?? "unknown browser"})`);
  if (x.fingerprint && !share) lines.push(`Key fingerprint: ${x.fingerprint} (the recipient's page shows the same digits)`);
  if (x.opened_at) lines.push(`Recipient fetched the secret ${x.opened_at}`);
  lines.push((share ? SHARE_NEXT_STEP[x.status] : undefined) ?? NEXT_STEP[x.status] ?? "");
  return lines.filter(Boolean).join("\n");
}

export async function serveMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
