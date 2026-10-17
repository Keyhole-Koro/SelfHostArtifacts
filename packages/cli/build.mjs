// Bundles the CLI (with @artifact/shared inlined) into dist/cli.js and copies the skills next to it.
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Runtime dependencies stay external; @artifact/shared (workspace-only) is bundled in.
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod"],
  banner: { js: "#!/usr/bin/env node" },
});
rmSync("skills", { recursive: true, force: true });
cpSync("../../skills", "skills", { recursive: true });
