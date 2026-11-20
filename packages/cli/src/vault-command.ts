import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactError } from "./client.ts";

/**
 * What a vault value may be piped into (`artifact vault use --run`, MCP `vault_use`), and how.
 *
 * The value goes only to the command's standard input, and the command must be one of the uses
 * below, each of which stores a secret where it is needed. A command is checked word by word (the
 * subcommand, each positional and each flag, and each flag's value against a pattern) and anything
 * else is refused: nothing may print the value or a credential (`gh auth token`, `gcloud secrets
 * versions access`, `--log-http`, `--debug`, `gh secret set --no-store`), read another file in
 * (`--flags-file`, `--env-file`, `gh secret set -f`), or point the tool at another host, account
 * store or configuration (`--host`, `--token`, `--configuration`, `--repo HOST/OWNER/REPO`, `--cwd`).
 *
 * What runs is rebuilt from the checked parts, without a shell, in an empty private directory: files
 * where the agent works cannot steer it (wrangler reads `.env` from its working directory, and a
 * CLOUDFLARE_API_BASE_URL there would send the value and the login elsewhere; gh would pick the
 * repository from the git remote). Output that contains the value, as is or in a simple encoding, is
 * withheld, so what comes back is the exit status and the tool's own short message.
 */

export const ALLOWED_COMMANDS = ["gcloud", "gh", "wrangler", "circleci"] as const;
type Tool = (typeof ALLOWED_COMMANDS)[number];

interface Flag {
  /** Its spellings; the first is the one used to run it. */
  names: readonly string[];
  /** The pattern its value must match; a switch has none. */
  value?: RegExp;
  hint: string;
  /** Accepted but already part of the command (gcloud's --data-file=-), so not added twice. */
  implied?: true;
}

interface Positional {
  hint: string;
  pattern: RegExp;
}

interface Use {
  tool: Tool;
  words: readonly string[];
  /** The accepted layouts of positionals, told apart by their number. */
  positionals: readonly (readonly Positional[])[];
  flags: readonly Flag[];
  /** Always added after the positionals. */
  fixed?: readonly string[];
  /** Combinations the flags must make; returns what is wrong. */
  check?: (has: (flag: string) => boolean, positionals: number) => string | undefined;
  usage: string;
}

// Values never start with "-", so the tool cannot read one as a flag.
const SECRET_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,254}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z][a-z0-9-]{1,62}$/;
const ACCOUNT = /^[A-Za-z0-9._%+][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
const OWNER_REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
const REPO_LIST = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_.-]{1,100})?(,[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_.-]{1,100})?)*$/;
const GH_ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_ENVIRONMENT = /^[A-Za-z0-9_.][A-Za-z0-9_. -]{0,99}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WRANGLER_ENV = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const WRANGLER_CONFIG = /^(\/|[A-Za-z]:[\\/])([^\0]*[\\/])?wrangler\.(toml|json|jsonc)$/;
const SLUG = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USES: readonly Use[] = [
  {
    tool: "gcloud",
    words: ["secrets", "versions", "add"],
    positionals: [[{ hint: "a Secret Manager secret id", pattern: SECRET_ID }]],
    fixed: ["--data-file=-"],
    flags: [
      { names: ["--data-file"], value: /^-$/, hint: "--data-file=-", implied: true },
      { names: ["--project"], value: PROJECT, hint: "--project PROJECT_ID" },
      { names: ["--location"], value: LOCATION, hint: "--location LOCATION" },
      { names: ["--account"], value: ACCOUNT, hint: "--account ACCOUNT" },
      { names: ["--quiet", "-q"], hint: "--quiet" },
    ],
    usage: "gcloud secrets versions add SECRET_ID --data-file=- [--project PROJECT_ID] [--location LOCATION] [--account ACCOUNT]",
  },
  {
    tool: "gh",
    words: ["secret", "set"],
    positionals: [[{ hint: "a secret name", pattern: VARIABLE }]],
    flags: [
      { names: ["--repo", "-R"], value: OWNER_REPO, hint: "--repo OWNER/REPO" },
      { names: ["--env", "-e"], value: GH_ENVIRONMENT, hint: "--env ENVIRONMENT" },
      { names: ["--org", "-o"], value: GH_ORG, hint: "--org ORG" },
      { names: ["--user", "-u"], hint: "--user" },
      { names: ["--app", "-a"], value: /^(actions|agents|codespaces|dependabot)$/, hint: "--app actions|agents|codespaces|dependabot" },
      { names: ["--visibility", "-v"], value: /^(all|private|selected)$/, hint: "--visibility all|private|selected" },
      { names: ["--repos", "-r"], value: REPO_LIST, hint: "--repos REPO,…" },
      { names: ["--no-repos-selected"], hint: "--no-repos-selected" },
    ],
    check: (has) =>
      [has("--repo"), has("--org"), has("--user")].filter(Boolean).length === 1
        ? undefined
        : "Say where the secret goes with exactly one of --repo OWNER/REPO, --org ORG or --user: the command runs outside your project, so gh cannot guess the repository.",
    usage: "gh secret set NAME (--repo OWNER/REPO [--env ENVIRONMENT] | --org ORG [--visibility all|private|selected] [--repos REPO,…] | --user [--repos OWNER/REPO,…]) [--app actions|agents|codespaces|dependabot]",
  },
  {
    tool: "wrangler",
    words: ["secret", "put"],
    positionals: [[{ hint: "a secret name", pattern: VARIABLE }]],
    flags: [
      { names: ["--name"], value: WORKER, hint: "--name WORKER" },
      { names: ["--env", "-e"], value: WRANGLER_ENV, hint: "--env ENVIRONMENT" },
      { names: ["--config", "-c"], value: WRANGLER_CONFIG, hint: "--config /absolute/path/wrangler.toml" },
    ],
    check: (has) =>
      has("--name") || has("--config")
        ? undefined
        : "Name the Worker with --name WORKER (or --config /absolute/path/wrangler.toml): the command runs outside your project, so wrangler cannot find its config.",
    usage: "wrangler secret put NAME (--name WORKER | --config /absolute/path/wrangler.toml) [--env ENVIRONMENT]",
  },
  {
    tool: "circleci",
    words: ["context", "store-secret"],
    positionals: [
      [
        { hint: "a context name", pattern: SLUG },
        { hint: "a variable name", pattern: VARIABLE },
      ],
      [
        { hint: "github or bitbucket", pattern: /^(github|bitbucket|gh|bb)$/ },
        { hint: "an organization name", pattern: SLUG },
        { hint: "a context name", pattern: SLUG },
        { hint: "a variable name", pattern: VARIABLE },
      ],
    ],
    flags: [
      { names: ["--org-id"], value: UUID, hint: "--org-id ORGANIZATION_ID" },
      { names: ["--skip-update-check"], hint: "--skip-update-check" },
    ],
    check: (has, positionals) =>
      (has("--org-id") ? positionals === 2 : positionals === 4)
        ? undefined
        : "Name the context as --org-id ORGANIZATION_ID CONTEXT NAME, or as github|bitbucket ORG CONTEXT NAME.",
    usage: "circleci context store-secret (--org-id ORGANIZATION_ID CONTEXT | github|bitbucket ORG CONTEXT) NAME",
  },
];

/** One line per allowed use, for tool descriptions and error messages. */
export const ALLOWED_USES: readonly string[] = USES.map((u) => u.usage);

export interface CommandPlan {
  tool: Tool;
  /** The program started: the tool's name, or $ARTIFACT_GCLOUD for gcloud (a wrapper the person chose). */
  bin: string;
  /** The arguments as checked, rebuilt from their parts. */
  args: string[];
  /** The command for messages, e.g. `gh secret set API_KEY --repo owner/repo`. */
  display: string;
}

const quoted = (word: string) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : JSON.stringify(word));

function refuse(problem: string): never {
  throw new ArtifactError(
    `${problem}\nA vault value can be piped only into:\n${ALLOWED_USES.map((u) => `  ${u}`).join("\n")}\n` +
      "To use it another way, the user can run `artifact vault use <collection> <name> --out <file>` in a terminal.",
    "bad_command",
  );
}

/** Checks a command against the allowed uses and returns what to run. Throws a message that lists what is allowed. */
export function checkCommand(command: readonly string[]): CommandPlan {
  const [tool, ...rest] = command;
  if (!tool || !(ALLOWED_COMMANDS as readonly string[]).includes(tool)) refuse(`A value cannot be piped into "${tool ?? ""}".`);
  if (command.length > 32 || command.some((word) => word.length > 1000)) refuse("The command is longer than any allowed use.");
  const use = USES.find((u) => u.tool === tool && u.words.every((w, i) => rest[i] === w));
  const shown = command.map(quoted).join(" ");
  if (!use) refuse(`"${shown}" is not one of the uses a value can be piped into.`);
  const where = `${use.tool} ${use.words.join(" ")}`;
  const allowedFlags = use.flags.map((f) => f.hint).join(", ");

  const given = new Map<Flag, string | true>();
  const positionals: string[] = [];
  const tokens = rest.slice(use.words.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    // --flag, --flag=value or --flag value; a short flag only as -x value. Nothing else.
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const flag = use.flags.find((f) => f.names.includes(name));
    if (!flag) refuse(`${name} is not allowed in "${where}" (allowed: ${allowedFlags}).`);
    if (given.has(flag)) refuse(`${flag.names[0]} is given twice.`);
    if (!flag.value) {
      if (eq > 0) refuse(`${flag.names[0]} takes no value.`);
      given.set(flag, true);
      continue;
    }
    const value = eq > 0 ? token.slice(eq + 1) : tokens[++i];
    if (value === undefined || !flag.value.test(value)) refuse(`${value === undefined ? "Nothing" : `"${value}"`} is not a value for ${flag.hint}.`);
    given.set(flag, value);
  }

  const layout = use.positionals.find((l) => l.length === positionals.length);
  if (!layout) refuse(`"${shown}" does not fit: ${use.usage}`);
  layout.forEach((p, i) => {
    if (!p.pattern.test(positionals[i]!)) refuse(`"${positionals[i]}" is not ${p.hint} (${use.usage}).`);
  });
  const has = (name: string) => [...given.keys()].some((f) => f.names[0] === name);
  const problem = use.check?.(has, positionals.length);
  if (problem) refuse(problem);

  const args = [...use.words, ...positionals, ...(use.fixed ?? [])];
  for (const [flag, value] of given) {
    if (flag.implied) continue;
    args.push(flag.names[0]!);
    if (value !== true) args.push(value);
  }
  // A wrapper path in ARTIFACT_GCLOUD (as for vault push) is resolved here, since the command runs elsewhere.
  const wrapper = use.tool === "gcloud" ? process.env["ARTIFACT_GCLOUD"] : undefined;
  const bin = wrapper ? (/[\\/]/.test(wrapper) ? resolve(wrapper) : wrapper) : use.tool;
  return { tool: use.tool, bin, args, display: [use.tool, ...args].map(quoted).join(" ") };
}

// ---- keeping the value out of what comes back ----

/** The value as a tool might print it: as is, trimmed, line by line, JSON- or URL-escaped, in hex, in base64 at each byte offset. */
function valueForms(value: Uint8Array): { form: string; anyCase: boolean }[] {
  const bytes = Buffer.from(value);
  const text = bytes.toString("utf8");
  const forms = new Map<string, boolean>();
  const add = (form: string, min: number, anyCase = false) => {
    if (form.length >= min) forms.set(anyCase ? form.toLowerCase() : form, anyCase);
  };
  add(text, 4);
  add(text.trim(), 4);
  for (const line of text.split(/\r?\n/)) add(line.trim(), 12);
  const json = JSON.stringify(text).slice(1, -1);
  add(json, 8);
  add(json.replace(/\//g, "\\/"), 8);
  add(encodeURIComponent(text), 8, true);
  add(encodeURIComponent(text).replace(/%20/g, "+"), 8, true);
  add(bytes.toString("hex"), 8, true);
  // Inside a longer base64 text the value can start at any of three byte offsets; keep the characters
  // that depend on the value alone.
  for (let shift = 0; shift < 3; shift++) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    const core = b64.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + bytes.length) * 8) / 6));
    add(core, 8);
    add(core.replace(/\+/g, "-").replace(/\//g, "_"), 8);
  }
  return [...forms].map(([form, anyCase]) => ({ form, anyCase }));
}

export function containsValue(text: string, value: Uint8Array): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return valueForms(value).some(({ form, anyCase }) => (anyCase ? lower : text).includes(form));
}

export const WITHHELD = "(not shown: it contained the value)";

// ---- running it ----

const MAX_OUTPUT = 64 * 1024;
const SHOWN_OUTPUT = 2000;

export interface PipeResult {
  exit_code: number;
  /** The tool's output, trimmed and cut short; withheld when it contained the value. */
  stdout: string;
  stderr: string;
}

function shownOutput(bytes: Buffer, over: boolean, value: Uint8Array): string {
  if (over) return `(not shown: more than ${MAX_OUTPUT / 1024} KiB of output)`;
  const text = bytes.toString("utf8");
  return containsValue(text, value) ? WITHHELD : text.trim().slice(0, SHOWN_OUTPUT);
}

/** Runs a checked command in an empty private directory, with the value on its standard input. */
export async function pipeValue(plan: CommandPlan, value: Uint8Array): Promise<PipeResult> {
  const cwd = mkdtempSync(join(tmpdir(), "artifact-vault-"));
  try {
    const r = await new Promise<{ code: number; out: Buffer; err: Buffer; overOut: boolean; overErr: boolean }>((resolvePromise, reject) => {
      const child = spawn(plan.bin, plan.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      child.stdout.on("data", (d: Buffer) => {
        outBytes += d.length;
        if (outBytes <= MAX_OUTPUT) out.push(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        errBytes += d.length;
        if (errBytes <= MAX_OUTPUT) err.push(d);
      });
      child.on("error", (e) => reject(new ArtifactError(`Could not run ${plan.tool}: ${e.message}`, "command_failed")));
      child.on("close", (code) =>
        resolvePromise({ code: code ?? -1, out: Buffer.concat(out), err: Buffer.concat(err), overOut: outBytes > MAX_OUTPUT, overErr: errBytes > MAX_OUTPUT }),
      );
      child.stdin.on("error", () => undefined);
      child.stdin.end(Buffer.from(value));
    });
    return { exit_code: r.code, stdout: shownOutput(r.out, r.overOut, value), stderr: shownOutput(r.err, r.overErr, value) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
