import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ArticleError } from "./client.ts";
import { list, publish, read, remove } from "./operations.ts";
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
    const message = e instanceof ArticleError ? e.message : `Unexpected error: ${(e as Error).message}`;
    return { ...text(message), isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "article", version: VERSION });

  server.registerTool(
    "publish",
    {
      title: "Publish a page",
      description:
        "Publish a local HTML page as a private web page and return its URL. Publishing the same file_path again updates the same URL " +
        "(a new version). Pass url to update a page that was published from another file. Read the article-design skill before writing " +
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
      },
    },
    ({ file_path, files, title, description, url, allow_connect }) =>
      run(async () => {
        const r = await publish({ filePath: file_path, files, title, description, url, allowConnect: allow_connect });
        return `${r.created ? "Published" : "Updated"}: ${r.url} (version ${r.version}, private; ${r.files} files, ${r.uploaded} uploaded)`;
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
      description: "List published pages, most recently updated first.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    ({ limit }) =>
      run(async () => {
        const { artifacts } = await list(limit ?? 25);
        if (artifacts.length === 0) return "Nothing is published yet.";
        return artifacts
          .map((a) => `${a.title} — ${a.url} (v${a.version}, updated ${a.updated_at})${a.description ? `\n  ${a.description}` : ""}`)
          .join("\n");
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

  return server;
}

export async function serveMcp(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
