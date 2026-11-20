import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactError } from "../src/client.ts";
import { ALLOWED_USES, checkCommand, containsValue, pipeValue, shellQuote, WITHHELD } from "../src/vault-command.ts";

afterEach(() => {
  delete process.env["ARTIFACT_GCLOUD"];
});

describe("checkCommand", () => {
  it("rebuilds an allowed command from its checked parts, in one spelling", () => {
    expect(checkCommand(["gcloud", "secrets", "versions", "add", "api-key", "--project=proj-123456", "--data-file", "-", "-q"]).args).toEqual([
      "secrets", "versions", "add", "api-key", "--data-file=-", "--project", "proj-123456", "--quiet",
    ]);
    expect(checkCommand(["gh", "secret", "set", "API_KEY", "-R", "owner/repo", "-e", "prod env"]).args).toEqual([
      "secret", "set", "API_KEY", "--repo", "owner/repo", "--env", "prod env",
    ]);
    expect(checkCommand(["gh", "secret", "set", "API_KEY", "--env=prod env", "--repo=owner/repo"]).display).toBe(
      "gh secret set API_KEY --env 'prod env' --repo owner/repo",
    );
    expect(checkCommand(["wrangler", "secret", "put", "API_KEY", "--config", "/home/me/app/wrangler.jsonc", "--env", "staging"]).args).toEqual([
      "secret", "put", "API_KEY", "--config", "/home/me/app/wrangler.jsonc", "--env", "staging",
    ]);
    expect(checkCommand(["circleci", "context", "store-secret", "github", "my-org", "my-context", "API_KEY"]).args).toEqual([
      "context", "store-secret", "github", "my-org", "my-context", "API_KEY",
    ]);
  });

  it("runs gcloud itself, not the ARTIFACT_GCLOUD wrapper that vault push takes", () => {
    // A wrapper is a program of its own, often kept where an agent edits files.
    process.env["ARTIFACT_GCLOUD"] = "/home/me/key-management/scripts/gcloud4";
    const plan = checkCommand(["gcloud", "secrets", "versions", "add", "api-key", "--data-file=-"]);
    expect(plan.bin).toBe("gcloud");
    expect(plan.display).toBe("gcloud secrets versions add api-key --data-file=-");
  });

  it("refuses spellings a tool would read differently from this check", () => {
    const smuggled = [
      ["gh", "secret", "set", "API_KEY", "-Rowner/repo"], // a short flag with its value attached
      ["gh", "secret", "set", "API_KEY", "--repo", "a/b", "--repo", "c/d"], // twice
      ["gh", "secret", "set", "--repo", "owner/repo", "--", "API_KEY"], // the end of flags
      ["gh", "secret", "set", "--user=true", "API_KEY"], // a value on a switch
      ["gcloud", "secrets", "versions", "add", "api-key", "--data-file=-", "--project", "--log-http"], // a flag as a value
      ["gcloud", "--project", "proj-123456", "secrets", "versions", "add", "api-key", "--data-file=-"], // flags before the subcommand
      ["gcloud", "secrets", "versions", "add", "projects/other/secrets/x", "--data-file=-"], // a resource name, not an id
      ["wrangler", "secret", "put", "API_KEY", "--config", "wrangler.toml"], // relative: resolved where it runs
      ["wrangler", "secret", "put", "API_KEY", "--config", "/home/me/.ssh/id_ed25519"], // not a wrangler config
      ["wrangler", "secret", "put", "API_KEY", "--config", "//server/share/wrangler.toml"], // a network share on Windows
      ["gh", "secret", "set", "API_KEY", "--org", "my-org"], // an organization's secret reaches every repository it is shared with
      ["gh", "secret", "set", "API_KEY", "--user"], // a Codespaces secret
      ["gh", "secret", "set", "API_KEY", "--repo", "owner/repo", "--app", "agents"], // Copilot sessions
      ["gh", "secret", "set", "API_KEY", "--repo", "owner/repo", "--visibility", "all"],
      ["wrangler", "secret", "put", "API_KEY", "--name", "w", "--envFile", "/tmp/x.env"], // yargs reads camelCase too
      ["circleci", "context", "store-secret", "--org-id", "6846e78b-2408-4dce-814f-04f444fde6ca", "github", "org", "ctx", "API_KEY"], // both forms
      ["gcloud", "secrets", "versions", "add", "api-key", "--data-file=-", "--account", `${"a.".repeat(5000)}@example.com`], // too long to check quickly
      ["sh", "-c", "cat"],
      ["/usr/bin/gh", "secret", "set", "API_KEY", "--repo", "owner/repo"], // another program by path
      [],
    ];
    for (const command of smuggled) expect(() => checkCommand(command), JSON.stringify(command)).toThrow(ArtifactError);
  });

  it("says what is allowed", () => {
    expect(() => checkCommand(["gh", "secret", "set", "API_KEY", "--repo", "owner/repo", "--no-store"])).toThrow(
      /--no-store is not allowed in "gh secret set" \(allowed: --repo OWNER\/REPO,/,
    );
    let message = "";
    try {
      checkCommand(["gh", "gist", "create", "-"]);
    } catch (e) {
      message = (e as Error).message;
    }
    for (const use of ALLOWED_USES) expect(message).toContain(use);
    expect(message).toContain("artifact vault use <collection> <name> --out <file>");
  });
});

describe("shellQuote", () => {
  it("quotes a word so that a shell reads it back as it was, running nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-quote-test-"));
    const words = [`envfile:///tmp/a'$(touch ${dir}/ran)'/.env#KEY`, "prod env", "#not-a-comment", "=ls", "~root", "`touch x`", "", "plain-word_1.2"];
    for (const word of words) {
      const back = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(word)}`], { encoding: "utf8" });
      expect(back).toBe(word);
    }
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });
});

describe("containsValue", () => {
  const value = Buffer.from("fake-S3cr/t+value=0123456789abcdef");

  it("finds the value as is and in simple encodings", () => {
    const text = value.toString("utf8");
    const forms = [
      text,
      `  ${text}\n`,
      value.toString("base64"),
      value.toString("base64url"),
      Buffer.concat([Buffer.from("{\"k\":\""), value]).toString("base64"),
      Buffer.concat([Buffer.from("a"), value]).toString("base64"),
      Buffer.concat([Buffer.from("ab"), value, Buffer.from("cd")]).toString("base64"),
      value.toString("hex").toUpperCase(),
      encodeURIComponent(text),
      encodeURIComponent(text).toLowerCase(),
      JSON.stringify({ text }),
    ];
    for (const form of forms) expect(containsValue(`before ${form} after`, value), form).toBe(true);
  });

  it("finds a long line of a value with several lines", () => {
    const pem = Buffer.from("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n");
    expect(containsValue("key: MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", pem)).toBe(true);
  });

  it("finds 16 characters of it in a row, also in an encoding broken into lines", () => {
    const text = value.toString("utf8");
    expect(containsValue(`ERROR: … ${text.slice(5, 21)}`, value)).toBe(true);
    const wrapped = value.toString("base64").replace(/(.{10})/g, "$1\n");
    expect(containsValue(wrapped, value)).toBe(true);
  });

  it("does not see it in what tools normally say", () => {
    expect(containsValue("Created version [3] of the secret [resend-api-key].", value)).toBe(false);
    expect(containsValue("✓ Set Actions secret API_KEY for owner/repo", value)).toBe(false);
    expect(containsValue("", value)).toBe(false);
  });
});

describe("pipeValue", () => {
  it("withholds both outputs when the value is split between them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-pipe-test-"));
    const bin = join(dir, "split");
    // Fifteen characters on each output: neither holds 16 in a row, the two together do.
    writeFileSync(bin, `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{process.stdout.write(s.slice(0,15));process.stderr.write(s.slice(15))})'\n`);
    chmodSync(bin, 0o755);
    const value = Buffer.from("fake-split-0123456789abcdefghi");
    const r = await pipeValue({ tool: "gh", bin, args: [], display: "gh" }, value);
    expect(r).toEqual({ exit_code: 0, stdout: WITHHELD, stderr: WITHHELD });
  });
});
