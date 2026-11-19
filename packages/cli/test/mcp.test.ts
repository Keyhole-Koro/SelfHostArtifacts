import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/mcp.ts";

/** The tools an agent sees. A tool added to or removed from mcp.ts is added or removed here too. */
const TOOLS = [
  "publish",
  "read",
  "list",
  "labels",
  "activity",
  "comments",
  "comment",
  "search",
  "move",
  "delete",
  "vault_list",
  "vault_create",
  "vault_put",
  "vault_use",
  "vault_devices",
  "vault_grant",
  "vault_destroy",
  "vault_status",
  "vault_target",
  "vault_push",
  "secret_share",
  "secret_request",
  "secret_status",
  "secret_send",
  "secret_delete",
];

let client: Client;

beforeEach(async () => {
  // An empty config directory: nobody is logged in, and the real profile and the OS keyring stay untouched.
  process.env["XDG_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "artifact-mcp-test-"));
  process.env["ARTIFACT_KEYRING"] = "file";
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  client = new Client({ name: "mcp-test", version: "0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
});

describe("MCP server", () => {
  it("lists every tool, each with an object input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect(tools.find((t) => t.name === "publish")?.inputSchema.required).toEqual(["file_path"]);
  });

  it("answers a call before login with a tool error that tells the agent what to do", async () => {
    const result = await client.callTool({ name: "list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Not logged in\./) }]);
  });
});
