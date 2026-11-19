import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactError } from "../src/client.ts";
import { utf8 } from "../src/vault-crypto.ts";
import { deliverEnvfile, deliverGcp, deliverGithub, gcloudVersionOf, targetState, writeEnvLine } from "../src/vault-push.ts";
import type { VaultTarget } from "@artifact/shared";

let work: string;
const originalPath = process.env["PATH"];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "artifact-push-test-"));
});
afterEach(() => {
  process.env["PATH"] = originalPath;
  delete process.env["ARTIFACT_GCLOUD"];
});

/** A fake command: a shell script in a temp bin directory. */
function fake(name: string, script: string): string {
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("env file lines", () => {
  it("creates the file with mode 0600, replaces an existing line, keeps the others, and quotes when needed", () => {
    const path = join(work, ".env.local");
    expect(writeEnvLine(path, "API_KEY", "abc123")).toEqual({ created: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("API_KEY=abc123\n");
    writeFileSync(path, "# dev\nexport API_KEY=old\nOTHER=1\n");
    expect(writeEnvLine(path, "API_KEY", "with space # and \"quote\"")).toEqual({ created: false });
    expect(readFileSync(path, "utf8")).toBe('# dev\nAPI_KEY="with space # and \\"quote\\""\nOTHER=1\n');
    writeEnvLine(path, "NEW_KEY", "x");
    expect(readFileSync(path, "utf8")).toBe('# dev\nAPI_KEY="with space # and \\"quote\\""\nOTHER=1\nNEW_KEY=x\n');
  });

  it("delivers to an env file and verifies by reading it back", () => {
    const path = join(work, ".env");
    const r = deliverEnvfile({ kind: "envfile", path, key: "TOKEN" }, utf8("t0k3n"));
    expect(r.verified).toBe(true);
    expect(r.remoteRef).toMatch(/^sha256 [0-9a-f]{12}$/);
    expect(readFileSync(path, "utf8")).toBe("TOKEN=t0k3n\n");
    expect(() => deliverEnvfile({ kind: "envfile", path, key: "TOKEN" }, utf8("two\nlines"))).toThrow(ArtifactError);
  });
});

describe("Secret Manager through gcloud", () => {
  it("adds a version from standard input, reads it back and marks it verified", async () => {
    const store = join(work, "sent");
    process.env["ARTIFACT_GCLOUD"] = fake("gcloud", `
if [ "$1 $2 $3" = "secrets versions add" ]; then cat > "${store}"; echo "Created version [7] of the secret [$4]." >&2; exit 0; fi
if [ "$1 $2 $3" = "secrets versions access" ]; then cat "${store}"; exit 0; fi
echo "unexpected: $*" >&2; exit 2`);
    const r = await deliverGcp({ kind: "gcp", project: "proj-123456", secret: "my-secret" }, utf8("s3cret-value"), true);
    expect(r).toEqual({ remoteRef: "version 7", verified: true });
    expect(readFileSync(store, "utf8")).toBe("s3cret-value");
  });

  it("notices when the value read back differs, and reports a failing gcloud without the value", async () => {
    process.env["ARTIFACT_GCLOUD"] = fake("gcloud", `
if [ "$1 $2 $3" = "secrets versions add" ]; then cat > /dev/null; echo "Created version [2] of the secret [x]."; exit 0; fi
if [ "$1 $2 $3" = "secrets versions access" ]; then printf 'tampered'; exit 0; fi
exit 2`);
    const r = await deliverGcp({ kind: "gcp", project: "proj-123456", secret: "x" }, utf8("real"), true);
    expect(r.remoteRef).toBe("version 2");
    expect(r.verified).toBe(false);
    expect(r.note).toMatch(/differs/);

    process.env["ARTIFACT_GCLOUD"] = fake("gcloud", 'cat > /dev/null; echo "ERROR: (gcloud.secrets.versions.add) PERMISSION_DENIED" >&2; exit 1');
    await expect(deliverGcp({ kind: "gcp", project: "proj-123456", secret: "x" }, utf8("real"), true)).rejects.toThrow(/exited with 1: ERROR: \(gcloud.secrets.versions.add\) PERMISSION_DENIED/);
  });

  it("reads the version number out of gcloud's message", () => {
    expect(gcloudVersionOf("Created version [12] of the secret [resend].")).toBe("12");
    expect(gcloudVersionOf("something else")).toBeUndefined();
  });
});

describe("GitHub Actions secrets through gh", () => {
  it("sets the secret from standard input and records the updated time from the list", async () => {
    const store = join(work, "gh-sent");
    const bin = join(work, "bin");
    fake("gh", `
if [ "$1 $2" = "secret set" ]; then cat > "${store}"; echo "✓ Set Actions secret $3"; exit 0; fi
if [ "$1 $2" = "secret list" ]; then echo '[{"name":"MY_SECRET","updatedAt":"2026-11-19T12:00:00Z"}]'; exit 0; fi
exit 2`);
    process.env["PATH"] = `${bin}:${originalPath}`;
    const r = await deliverGithub({ kind: "github", owner: "o", repo: "r", name: "MY_SECRET" }, utf8("value"));
    expect(r).toEqual({ remoteRef: "updated 2026-11-19T12:00:00Z", verified: false });
    expect(readFileSync(store, "utf8")).toBe("value");
  });
});

describe("status words", () => {
  const delivery = (version: number, result: "delivered" | "failed", at: string): NonNullable<VaultTarget["latest"]> => ({ id: "d", version, result, remote_ref: null, verified_at: null, delivered_at: at, delivered_by: "dev", note: null });
  const target = (latest: VaultTarget["latest"], delivered: VaultTarget["delivered"]): VaultTarget => ({ id: "t", kind: "gcp", address: "gcp://p/s", plaintext_ok: false, added_by: "dev", added_at: "", removed_at: null, latest, delivered });

  it("tells delivered, stale, never and failed apart", () => {
    expect(targetState(target(null, null), 1)).toBe("never");
    const ok = delivery(2, "delivered", "2026-11-19T01:00:00Z");
    expect(targetState(target(ok, ok), 2)).toBe("delivered");
    expect(targetState(target(ok, ok), 3)).toBe("stale");
    const failedLater = delivery(3, "failed", "2026-11-19T02:00:00Z");
    expect(targetState(target(failedLater, ok), 3)).toBe("failed");
    const failedEarlier = delivery(1, "failed", "2026-11-19T00:00:00Z");
    expect(targetState(target(failedEarlier, ok), 2)).toBe("delivered");
  });
});
