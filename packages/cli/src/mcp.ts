import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ArtifactError } from "./client.ts";
import { list, move, publish, read, remove, search, secretDelete, secretList, secretRequest, secretSend, secretShare, secretStatus, type SecretState } from "./operations.ts";
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
      },
    },
    ({ file_path, files, title, description, url, allow_connect, project, parent }) =>
      run(async () => {
        const r = await publish({ filePath: file_path, files, title, description, url, allowConnect: allow_connect, project, parent });
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
      description: "List published pages, most recently updated first, optionally of one project.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        project: z.string().optional().describe("Only pages in this project"),
      },
    },
    ({ limit, project }) =>
      run(async () => {
        const { artifacts } = await list(limit ?? 25, project);
        if (artifacts.length === 0) return project ? `No page in ${project}.` : "Nothing is published yet.";
        return artifacts
          .map(
            (a) =>
              `${a.title} — ${a.url} (v${a.version}, updated ${a.updated_at}${a.project ? `, ${a.project}` : ""})${a.description ? `\n  ${a.description}` : ""}`,
          )
          .join("\n");
      }),
  );

  server.registerTool(
    "search",
    {
      title: "Search pages",
      description:
        "Find published pages whose title, description or text has every word of the query (any part of a word, Japanese included). " +
        "Use it before writing a page, to link to what exists instead of repeating it.",
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
          .map((h) => `${h.title} — ${h.url}${h.project ? ` (${h.project})` : ""}\n  ${h.snippet.replace(/\s+/g, " ")}`)
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
