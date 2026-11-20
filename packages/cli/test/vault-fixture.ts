import { vaultContext, type VaultStatusResponse, type VaultTarget, type VaultVersionResponse } from "@artifact/shared";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, newDataKey, seal, utf8, wrapTo } from "../src/vault-crypto.ts";

/**
 * A logged-in profile in a temp directory and a local server that holds one vault collection, encrypted
 * the way the Worker stores it, so tests open real values with this device's key. Fake commands go in
 * `bin`, which the caller puts first on PATH. Every value here is made up.
 */

export const COLLECTION = "test-prod";
const MEMBER = "member-device";

export interface Fixture {
  work: string;
  bin: string;
  /** "METHOD /path" of every request the server got. */
  requests: string[];
  /** Bodies of the delivery records the device sent. */
  deliveries: Record<string, unknown>[];
  put(name: string, value: string, version?: number): Promise<void>;
  /** A target that exists only on the server, as if another computer (or a hijacked Worker) added it. */
  serverTarget(name: string, address: string): void;
  /** A shell script named `name` in `bin`. */
  fake(name: string, script: string): void;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body });

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function vaultFixture(): Promise<Fixture> {
  const work = mkdtempSync(join(tmpdir(), "artifact-vault-fixture-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  process.env["XDG_CONFIG_HOME"] = join(work, "config");
  process.env["ARTIFACT_KEYRING"] = "file";
  delete process.env["ARTIFACT_PROFILE"];
  const profile = join(work, "config", "artifact", "default");
  mkdirSync(profile, { recursive: true, mode: 0o700 });

  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(join(profile, "key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const device = await generateKeyPair();
  writeFileSync(join(profile, "vault-key.json"), JSON.stringify(device.privateJwk), { mode: 0o600 });
  const collectionKey = await generateKeyPair();
  const grant = await wrapTo(device.publicKey, vaultContext.collectionKey(COLLECTION, 1, MEMBER), utf8(JSON.stringify(collectionKey.privateJwk)));

  const versions = new Map<string, VaultVersionResponse>();
  const targets = new Map<string, VaultTarget[]>();
  const requests: string[] = [];
  const deliveries: Record<string, unknown>[] = [];
  let nextId = 1;

  const newTarget = (address: string, plaintextOk: boolean): VaultTarget => ({
    id: `t${nextId++}`,
    kind: address.slice(0, address.indexOf(":")) as VaultTarget["kind"],
    address,
    plaintext_ok: plaintextOk,
    added_by: "dev1",
    added_at: "2026-11-20T00:00:00Z",
    removed_at: null,
    latest: null,
    delivered: null,
  });

  const route = async (method: string, path: string, req: IncomingMessage): Promise<{ status: number; body: unknown }> => {
    const base = `/api/v1/vault/collections/${COLLECTION}`;
    if (method === "GET" && path === `${base}/status`) {
      const secrets = [...versions.keys()].map((name) => ({ name, description: null, used_by: null, current_version: versions.get(name)!.version, updated_at: "2026-11-20T00:00:00Z", targets: targets.get(name) ?? [] }));
      return json(200, { collection: COLLECTION, key_version: 1, secrets } satisfies VaultStatusResponse);
    }
    const m = new RegExp(`^${base}/secrets/([^/]+)(/.*)?$`).exec(path);
    if (!m) return json(404, { error: { code: "not_found", message: `No route for ${method} ${path}` } });
    const name = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";
    const version = versions.get(name);
    if (!version) return json(404, { error: { code: "not_found", message: `"${name}" is not in "${COLLECTION}".` } });
    if (method === "GET" && /^\/versions\/(latest|\d+)$/.test(rest)) return json(200, version);
    const list = targets.get(name) ?? [];
    targets.set(name, list);
    if (method === "GET" && rest === "/targets") return json(200, { targets: list });
    if (method === "POST" && rest === "/targets") {
      const body = await bodyOf(req);
      const target = newTarget(String(body["address"]), body["plaintext_ok"] === true);
      list.push(target);
      return json(201, target);
    }
    const t = /^\/targets\/([^/]+)(\/deliveries)?$/.exec(rest);
    const target = t ? list.find((x) => x.id === t[1]) : undefined;
    if (t && target && method === "DELETE" && !t[2]) {
      list.splice(list.indexOf(target), 1);
      return json(200, { removed: true });
    }
    if (t && target && method === "POST" && t[2]) {
      const body = await bodyOf(req);
      deliveries.push({ target: target.address, ...body });
      const record = { id: `d${nextId++}`, version: Number(body["version"]), result: body["result"] as "delivered" | "failed", remote_ref: null, verified_at: null, delivered_at: new Date().toISOString(), delivered_by: "dev1", note: (body["note"] as string | undefined) ?? null };
      target.latest = record;
      if (record.result === "delivered") target.delivered = record;
      return json(201, target);
    }
    return json(404, { error: { code: "not_found", message: `No route for ${method} ${path}` } });
  };

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0]!;
    requests.push(`${method} ${path}`);
    route(method, path, req).then(
      ({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      },
      (e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "test", message: String(e) } }));
      },
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(profile, "config.json"), JSON.stringify({ host: `127.0.0.1:${port}`, device_id: "dev1", vault_member_id: MEMBER, vault_public_key: device.publicKey }), { mode: 0o600 });

  return {
    work,
    bin,
    requests,
    deliveries,
    async put(name, value, version = 1) {
      const dek = newDataKey();
      versions.set(name, {
        collection: COLLECTION,
        secret: name,
        version,
        key_version: 1,
        wrapped_dek: await wrapTo(collectionKey.publicKey, vaultContext.dataKey(COLLECTION, name, version), dek),
        ciphertext: await seal(dek, vaultContext.value(COLLECTION, name, version), utf8(value)),
        grant,
        collection_public_key: collectionKey.publicKey,
      });
    },
    serverTarget(name, address) {
      const list = targets.get(name) ?? [];
      list.push(newTarget(address, address.startsWith("envfile:")));
      targets.set(name, list);
    },
    fake(name, script) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${script}\n`);
      chmodSync(path, 0o755);
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
