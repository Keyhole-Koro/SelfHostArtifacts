// Manual smoke test: talks to `article mcp` over stdio like an agent does.
// Usage: XDG_CONFIG_HOME=... node test/mcp-smoke.mjs /abs/page.html
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp"], env: process.env }));
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`${name}${r.isError ? " (error)" : ""}:`, r.content[0].text.split("\n")[0]);
  return r;
};
const pub = await call("publish", { file_path: process.argv[2] });
const url = /(https?:\/\/\S+\/a\/[0-9a-z]+)/.exec(pub.content[0].text)?.[1];
await call("publish", { file_path: process.argv[2], description: "updated via MCP" });
await call("read", { url });
await call("list", {});
await call("publish", { file_path: "/nonexistent/page.html" });
await call("delete", { url });
await client.close();
