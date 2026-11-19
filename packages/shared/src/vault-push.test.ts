import { describe, expect, it } from "vitest";
import { formatVaultTarget, parseVaultTarget, targetIsStale, type VaultTarget } from "./vault-push.ts";

describe("delivery target addresses", () => {
  it("parses each kind and prints it back in canonical form", () => {
    expect(parseVaultTarget("gcp://medishare-492402/medishare-resend-api-key")).toEqual({ kind: "gcp", project: "medishare-492402", secret: "medishare-resend-api-key" });
    expect(parseVaultTarget("circleci://gh/Keyhole-Koro/medishare-stg/STG_SITE_PASSWORD?token=tools/CIRCLECI_API_TOKEN")).toEqual({
      kind: "circleci", vcs: "gh", org: "Keyhole-Koro", context: "medishare-stg", variable: "STG_SITE_PASSWORD", tokenFrom: { collection: "tools", name: "CIRCLECI_API_TOKEN" },
    });
    expect(parseVaultTarget("github://Keyhole-Koro/MediShare/SYNTHETIC_BOT_PASSWORD_STG?environment=stg")).toEqual({ kind: "github", owner: "Keyhole-Koro", repo: "MediShare", name: "SYNTHETIC_BOT_PASSWORD_STG", environment: "stg" });
    expect(parseVaultTarget("wrangler://artifacts/SESSION_SECRET?config=wrangler.local.toml&cwd=packages%2Fworker")).toEqual({ kind: "wrangler", worker: "artifacts", name: "SESSION_SECRET", config: "wrangler.local.toml", cwd: "packages/worker" });
    expect(parseVaultTarget("envfile:///home/me/app/.env.local#PAYJP_SECRET_KEY")).toEqual({ kind: "envfile", path: "/home/me/app/.env.local", key: "PAYJP_SECRET_KEY" });
    for (const address of [
      "gcp://medishare-492402/medishare-resend-api-key",
      "circleci://gh/Keyhole-Koro/medishare-stg/STG_SITE_PASSWORD?token=tools/CIRCLECI_API_TOKEN",
      "github://Keyhole-Koro/MediShare/SYNTHETIC_BOT_PASSWORD_STG?environment=stg",
      "wrangler://artifacts/SESSION_SECRET?config=wrangler.local.toml&cwd=packages%2Fworker",
      "envfile:///home/me/app/.env.local#PAYJP_SECRET_KEY",
    ]) expect(formatVaultTarget(parseVaultTarget(` ${address} `))).toBe(address);
  });

  it("explains what is wrong with a bad address", () => {
    const message = (address: string) => {
      try {
        parseVaultTarget(address);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`expected ${address} to fail`);
    };
    expect(message("s3://bucket/key")).toMatch(/unknown kind "s3"/);
    expect(message("gcp://Medishare/x")).toMatch(/not a GCP project id/);
    expect(message("gcp://medishare-492402")).toMatch(/gcp:\/\/<project>\/<secret id>/);
    expect(message("gcp://medishare-492402/x?foo=1")).toMatch(/unknown option "foo"/);
    expect(message("circleci://svn/org/ctx/VAR")).toMatch(/gh or bb/);
    expect(message("circleci://gh/org/ctx/VAR?token=nope")).toMatch(/token=<collection>\/<name>/);
    expect(message("github://owner/repo/GITHUB_TOKEN")).toMatch(/not an Actions secret name/);
    expect(message("github://owner/repo/1BAD")).toMatch(/not an Actions secret name/);
    expect(message("wrangler://My Worker/NAME")).toMatch(/not a Worker name/);
    expect(message("envfile://relative/.env#KEY")).toMatch(/absolute/);
    expect(message("envfile:///home/me/.env")).toMatch(/after #/);
    expect(message(`gcp://medishare-492402/${"a".repeat(400)}`)).toMatch(/longer than 400/);
  });

  it("knows when a target is behind", () => {
    const delivered = (version: number): VaultTarget["delivered"] => ({ id: "d", version, result: "delivered", remote_ref: null, verified_at: null, delivered_at: "2026-11-19T00:00:00.000Z", delivered_by: "dev", note: null });
    const target = (d: VaultTarget["delivered"]): VaultTarget => ({ id: "t", kind: "gcp", address: "gcp://p/s", plaintext_ok: false, added_by: "dev", added_at: "", removed_at: null, latest: d, delivered: d });
    expect(targetIsStale(target(null), 1)).toBe(true);
    expect(targetIsStale(target(delivered(1)), 2)).toBe(true);
    expect(targetIsStale(target(delivered(2)), 2)).toBe(false);
    expect(targetIsStale(target(delivered(3)), 2)).toBe(false);
  });
});
