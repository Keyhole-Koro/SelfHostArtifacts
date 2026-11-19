import {
  vaultCollectionCreateSchema,
  vaultCollectionName,
  vaultGrantCreateSchema,
  vaultMemberRegisterSchema,
  vaultOwnerSetSchema,
  vaultRotateSchema,
  vaultSecretName,
  vaultSecretPatchSchema,
  vaultSecretPutSchema,
  type VaultCollectionDetail,
  type VaultCollectionSummary,
  type VaultEnvelope,
  type VaultMember,
  type VaultRotationPlan,
  type VaultSealed,
  type VaultVersionResponse,
} from "@artifact/shared";
import { Hono, type Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../app-env.ts";
import { recordAuditEvent } from "../db/audit.ts";
import {
  addGrant,
  collectionByName,
  createCollection,
  deleteSecret,
  destroyVersion,
  getGrant,
  getMember,
  getVersion,
  grantedMembers,
  listCollections,
  listMembers,
  listSecrets,
  listVersions,
  liveVersions,
  memberByDevice,
  memberView,
  ownerMember,
  ownerView,
  putVersion,
  removeGrants,
  rotateCollection,
  secretByName,
  secretSummary,
  setOwner,
  updateSecretLedger,
  upsertDeviceMember,
  type CollectionRow,
  type MemberRow,
} from "../db/vault.ts";
import { apiError } from "../lib/api-error.ts";

/**
 * The vault API (signed by a device; mounted under /api/v1/vault). The Worker checks who may read
 * what, stores wrapped keys and ciphertexts, and keeps the ledger. It never opens anything: every
 * key it holds is wrapped for a member's public key. See docs/design.md, "金庫".
 */
export const vault = new Hono<AppEnv>();

async function readJson<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; res: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, res: apiError(c, 400, "bad_request", "The body must be JSON.") };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, res: apiError(c, 400, "bad_request", parsed.error.issues.map((i) => i.message).join("; ")) };
  return { ok: true, value: parsed.data };
}

const NO_KEY = "This device has no vault key yet. Run `artifact vault key` (or `artifact vault init`) on it first.";
const NOT_READABLE = (name: string) =>
  `This device cannot open the collection "${name}". A device that can (or the owner, with the recovery key) must run \`artifact vault grant ${name} <this device>\`.`;

async function callerMember(c: Context<AppEnv>): Promise<MemberRow | null> {
  const member = await memberByDevice(c.env.DB, c.get("device").id);
  return member && member.revoked_at === null ? member : null;
}

function collectionName(c: Context<AppEnv>): { ok: true; name: string } | { ok: false; res: Response } {
  const parsed = vaultCollectionName.safeParse(c.req.param("name"));
  return parsed.success ? { ok: true, name: parsed.data } : { ok: false, res: apiError(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "bad name") };
}

async function loadCollection(c: Context<AppEnv>): Promise<{ ok: true; collection: CollectionRow } | { ok: false; res: Response }> {
  const name = collectionName(c);
  if (!name.ok) return name;
  const collection = await collectionByName(c.env.DB, name.name);
  if (!collection) return { ok: false, res: apiError(c, 404, "not_found", `No collection is named "${name.name}". \`artifact vault list\` shows them; \`artifact vault create ${name.name}\` makes it.`) };
  return { ok: true, collection };
}

/** The caller's grant for the collection's current key, or the 403 to return. */
async function readableBy(c: Context<AppEnv>, collection: CollectionRow, member: MemberRow | null): Promise<{ ok: true; member: MemberRow; envelope: VaultEnvelope } | { ok: false; res: Response }> {
  if (!member) return { ok: false, res: apiError(c, 403, "no_key", NO_KEY) };
  const grant = await getGrant(c.env.DB, collection.id, member.id, collection.key_version);
  if (!grant) return { ok: false, res: apiError(c, 403, "no_grant", NOT_READABLE(collection.name)) };
  return { ok: true, member, envelope: JSON.parse(grant.envelope) as VaultEnvelope };
}

function audit(c: Context<AppEnv>, action: string, targetType: string, targetId: string | null, metadata?: Record<string, string | number | boolean | null>) {
  const device = c.get("device");
  return recordAuditEvent(c, { actorType: "device", actorId: device.id, actorLabel: device.name, action, targetType, targetId, ...(metadata ? { metadata } : {}) });
}

async function summarize(c: Context<AppEnv>, collection: CollectionRow, member: MemberRow | null): Promise<VaultCollectionDetail> {
  const [grants, secrets, myGrant] = await Promise.all([
    grantedMembers(c.env.DB, collection),
    listSecrets(c.env.DB, collection.id),
    member ? getGrant(c.env.DB, collection.id, member.id, collection.key_version) : Promise.resolve(null),
  ]);
  return {
    name: collection.name,
    key_version: collection.key_version,
    members: grants.length,
    secrets: secrets.length,
    readable: myGrant !== null,
    created_at: collection.created_at,
    updated_at: collection.updated_at,
    public_key: collection.public_key,
    grants: grants.map(memberView),
    my_grant: myGrant ? (JSON.parse(myGrant.envelope) as VaultEnvelope) : null,
  };
}

/** Grants must name the caller and the owner (when there is one); every member must exist and be live. */
async function checkGrantTargets(c: Context<AppEnv>, grants: { member_id: string }[], caller: MemberRow): Promise<Response | null> {
  const ids = new Set(grants.map((g) => g.member_id));
  if (!ids.has(caller.id)) return apiError(c, 400, "bad_request", "The grants must include this device's own member id.");
  const owner = await ownerMember(c.env.DB);
  if (owner && !ids.has(owner.id)) return apiError(c, 400, "owner_required", "The grants must include the owner key, so the recovery key can open the collection.");
  for (const id of ids) {
    const member = await getMember(c.env.DB, id);
    if (!member || member.revoked_at !== null) return apiError(c, 400, "unknown_member", `"${id}" is not a vault member. \`artifact vault devices\` lists them.`);
  }
  return null;
}

// ---- members and the owner key ----

vault.put("/members/me", async (c) => {
  const parsed = await readJson(c, vaultMemberRegisterSchema);
  if (!parsed.ok) return parsed.res;
  const { member, created, keyChanged } = await upsertDeviceMember(c.env.DB, c.get("device").id, parsed.value.public_key);
  if (created || keyChanged) await audit(c, "vault.member_register", "vault_member", member.id, { key_changed: keyChanged });
  return c.json<VaultMember & { key_changed: boolean }>({ ...memberView(member), key_changed: keyChanged }, created ? 201 : 200);
});

vault.get("/members", async (c) => {
  const members = await listMembers(c.env.DB);
  return c.json<{ members: VaultMember[] }>({ members: members.map(memberView) });
});

vault.get("/owner", async (c) => {
  const owner = await ownerView(c.env.DB);
  if (!owner) return apiError(c, 404, "no_owner", "The vault has no owner key yet. Run `artifact vault init`.");
  return c.json(owner);
});

vault.put("/owner", async (c) => {
  const parsed = await readJson(c, vaultOwnerSetSchema);
  if (!parsed.ok) return parsed.res;
  const existing = await ownerMember(c.env.DB);
  if (existing && existing.public_key !== parsed.value.public_key) {
    return apiError(c, 409, "owner_exists", "The vault already has an owner key. New wraps (a new recovery key) must be for that same key.");
  }
  const { owner, created } = await setOwner(c.env.DB, parsed.value.public_key, parsed.value.wraps);
  await audit(c, "vault.owner_set", "vault_member", owner.id, { created, wraps: parsed.value.wraps.map((w) => w.wrapped_by).join(",") });
  return c.json(await ownerView(c.env.DB), created ? 201 : 200);
});

// ---- collections ----

vault.post("/collections", async (c) => {
  const parsed = await readJson(c, vaultCollectionCreateSchema);
  if (!parsed.ok) return parsed.res;
  const caller = await callerMember(c);
  if (!caller) return apiError(c, 403, "no_key", NO_KEY);
  const bad = await checkGrantTargets(c, parsed.value.grants, caller);
  if (bad) return bad;
  if (await collectionByName(c.env.DB, parsed.value.name)) return apiError(c, 409, "exists", `A collection named "${parsed.value.name}" already exists.`);
  const collection = await createCollection(c.env.DB, { name: parsed.value.name, publicKey: parsed.value.public_key, createdBy: c.get("device").id, grants: parsed.value.grants });
  await audit(c, "vault.collection_create", "vault_collection", collection.id, { name: collection.name, members: parsed.value.grants.length });
  return c.json<VaultCollectionDetail>(await summarize(c, collection, caller), 201);
});

vault.get("/collections", async (c) => {
  const caller = await callerMember(c);
  const rows = await listCollections(c.env.DB, caller?.id ?? null);
  return c.json<{ collections: VaultCollectionSummary[]; member_id: string | null }>({
    member_id: caller?.id ?? null,
    collections: rows.map((r) => ({
      name: r.name,
      key_version: r.key_version,
      members: r.members,
      secrets: r.secrets,
      readable: r.readable > 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

vault.get("/collections/:name", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  return c.json<VaultCollectionDetail>(await summarize(c, loaded.collection, await callerMember(c)));
});

// ---- grants ----

vault.post("/collections/:name/grants", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const parsed = await readJson(c, vaultGrantCreateSchema);
  if (!parsed.ok) return parsed.res;
  const { collection } = loaded;
  const caller = await callerMember(c);
  if (!caller) return apiError(c, 403, "no_key", NO_KEY);
  if (parsed.value.key_version !== collection.key_version) {
    return apiError(c, 409, "key_rotated", `The collection key is now version ${collection.key_version}. Read the collection again and wrap that key.`);
  }
  const target = await getMember(c.env.DB, parsed.value.member_id);
  if (!target || target.revoked_at !== null) return apiError(c, 400, "unknown_member", `"${parsed.value.member_id}" is not a vault member. \`artifact vault devices\` lists them.`);
  // A device may add a grant for itself without holding one (that is how recovery re-admits a
  // device: only a real collection key, opened with the recovery key, makes a grant that works).
  // Granting anyone else needs a grant of one's own.
  if (target.id !== caller.id) {
    const readable = await readableBy(c, collection, caller);
    if (!readable.ok) return readable.res;
  }
  await addGrant(c.env.DB, collection, target.id, parsed.value.envelope, c.get("device").id);
  await audit(c, "vault.grant", "vault_collection", collection.id, { name: collection.name, member: target.id, self: target.id === caller.id });
  return c.json<VaultCollectionDetail>(await summarize(c, collection, caller), 201);
});

async function rotationPlan(c: Context<AppEnv>, collection: CollectionRow): Promise<VaultRotationPlan> {
  const [members, versions] = await Promise.all([grantedMembers(c.env.DB, collection), liveVersions(c.env.DB, collection.id)]);
  return {
    key_version: collection.key_version,
    public_key: collection.public_key,
    members: members.map(memberView),
    versions: versions.map((v) => ({ secret: v.secret, version: v.version, key_version: v.key_version, wrapped_dek: JSON.parse(v.wrapped_dek) as VaultEnvelope })),
  };
}

vault.delete("/collections/:name/grants/:member", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const { collection } = loaded;
  const readable = await readableBy(c, collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const target = await getMember(c.env.DB, c.req.param("member"));
  if (!target) return apiError(c, 404, "unknown_member", "No vault member has this id.");
  if (target.kind === "owner") return apiError(c, 400, "owner_required", "The owner key keeps its grant, so the recovery key can always open the collection.");
  const removed = await removeGrants(c.env.DB, collection.id, target.id);
  if (removed) await audit(c, "vault.revoke", "vault_collection", collection.id, { name: collection.name, member: target.id });
  // The revoked device may have copied the collection key: the caller rotates it next.
  return c.json<{ removed: boolean; rotation: VaultRotationPlan }>({ removed, rotation: await rotationPlan(c, collection) });
});

/** The collection key wrapped for the owner: only the owner key (opened with the recovery key) can use it. */
vault.get("/collections/:name/owner-grant", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const owner = await ownerMember(c.env.DB);
  const grant = owner ? await getGrant(c.env.DB, loaded.collection.id, owner.id, loaded.collection.key_version) : null;
  return c.json<{ key_version: number; grant: VaultEnvelope | null }>({ key_version: loaded.collection.key_version, grant: grant ? (JSON.parse(grant.envelope) as VaultEnvelope) : null });
});

vault.get("/collections/:name/rotation", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  return c.json<VaultRotationPlan>(await rotationPlan(c, loaded.collection));
});

vault.post("/collections/:name/rotate", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const { collection } = loaded;
  const caller = await callerMember(c);
  const readable = await readableBy(c, collection, caller);
  if (!readable.ok) return readable.res;
  const parsed = await readJson(c, vaultRotateSchema);
  if (!parsed.ok) return parsed.res;
  if (parsed.value.key_version !== collection.key_version + 1) {
    return apiError(c, 409, "key_rotated", `The collection key is at version ${collection.key_version}; a rotation must bring version ${collection.key_version + 1}. Read the rotation plan again.`);
  }
  const bad = await checkGrantTargets(c, parsed.value.grants, readable.member);
  if (bad) return bad;
  // Every live version must be re-wrapped, or its value would be lost with the old key.
  const live = await liveVersions(c.env.DB, collection.id);
  const given = new Map(parsed.value.versions.map((v) => [`${v.secret}\0${v.version}`, v.wrapped_dek]));
  const missing = live.filter((v) => !given.has(`${v.secret}\0${v.version}`));
  if (missing.length) {
    return apiError(c, 409, "versions_missing", `The rotation leaves out ${missing.length} live version(s): ${missing.slice(0, 5).map((v) => `${v.secret}@${v.version}`).join(", ")}. Read the rotation plan again.`);
  }
  const versions = live.map((v) => ({ secret_id: v.secret_id, version: v.version, wrapped_dek: given.get(`${v.secret}\0${v.version}`)! }));
  const done = await rotateCollection(c.env.DB, collection, { keyVersion: parsed.value.key_version, publicKey: parsed.value.public_key, grants: parsed.value.grants, versions, by: c.get("device").id });
  if (!done) return apiError(c, 409, "key_rotated", "Another rotation finished first. Read the rotation plan again.");
  await audit(c, "vault.rotate", "vault_collection", collection.id, { name: collection.name, key_version: parsed.value.key_version, members: parsed.value.grants.length, versions: versions.length });
  const fresh = (await collectionByName(c.env.DB, collection.name))!;
  return c.json<VaultCollectionDetail>(await summarize(c, fresh, caller));
});

// ---- secrets ----

function secretName(c: Context<AppEnv>): { ok: true; name: string } | { ok: false; res: Response } {
  const parsed = vaultSecretName.safeParse(c.req.param("secret"));
  return parsed.success ? { ok: true, name: parsed.data } : { ok: false, res: apiError(c, 400, "bad_request", parsed.error.issues[0]?.message ?? "bad name") };
}

vault.get("/collections/:name/secrets", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const rows = await listSecrets(c.env.DB, loaded.collection.id);
  return c.json({ collection: loaded.collection.name, secrets: rows.map(secretSummary) });
});

/** Anyone with a device may put a value: it only needs the collection's public key. Reading needs a grant. */
vault.put("/collections/:name/secrets/:secret", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const parsed = await readJson(c, vaultSecretPutSchema);
  if (!parsed.ok) return parsed.res;
  const { collection } = loaded;
  if (parsed.value.key_version !== collection.key_version) {
    return apiError(c, 409, "key_rotated", `The collection key is now version ${collection.key_version}. Read the collection again and wrap the data key for its current key.`, {
      key_version: collection.key_version,
      public_key: collection.public_key,
    });
  }
  const result = await putVersion(c.env.DB, {
    collectionId: collection.id,
    name: name.name,
    version: parsed.value.version,
    description: parsed.value.description,
    usedBy: parsed.value.used_by,
    keyVersion: parsed.value.key_version,
    wrappedDek: parsed.value.wrapped_dek,
    ciphertext: parsed.value.ciphertext,
    createdBy: c.get("device").id,
  });
  if (!result.ok) {
    return apiError(c, 409, "version_conflict", `"${name.name}" is at version ${result.current}; encrypt for version ${result.current + 1} and put again.`, { current_version: result.current });
  }
  await audit(c, "vault.put", "vault_secret", result.secret.id, { collection: collection.name, name: name.name, version: parsed.value.version });
  return c.json({ collection: collection.name, name: name.name, version: parsed.value.version, created_at: result.secret.updated_at }, 201);
});

vault.patch("/collections/:name/secrets/:secret", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const parsed = await readJson(c, vaultSecretPatchSchema);
  if (!parsed.ok) return parsed.res;
  const secret = await secretByName(c.env.DB, loaded.collection.id, name.name);
  if (!secret) return apiError(c, 404, "not_found", `"${name.name}" is not in "${loaded.collection.name}".`);
  await updateSecretLedger(c.env.DB, secret.id, { description: parsed.value.description, usedBy: parsed.value.used_by });
  await audit(c, "vault.ledger", "vault_secret", secret.id, { collection: loaded.collection.name, name: name.name });
  const rows = await listSecrets(c.env.DB, loaded.collection.id);
  return c.json(secretSummary(rows.find((r) => r.id === secret.id)!));
});

vault.get("/collections/:name/secrets/:secret", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const secret = await secretByName(c.env.DB, loaded.collection.id, name.name);
  if (!secret) return apiError(c, 404, "not_found", `"${name.name}" is not in "${loaded.collection.name}".`);
  const rows = await listSecrets(c.env.DB, loaded.collection.id);
  return c.json({ ...secretSummary(rows.find((r) => r.id === secret.id)!), collection: loaded.collection.name, versions: await listVersions(c.env.DB, secret.id) });
});

/** One version, with everything the device needs to open it. Each read goes into the audit log. */
vault.get("/collections/:name/secrets/:secret/versions/:version", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const { collection } = loaded;
  const readable = await readableBy(c, collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const secret = await secretByName(c.env.DB, collection.id, name.name);
  if (!secret) return apiError(c, 404, "not_found", `"${name.name}" is not in "${collection.name}".`);
  const wanted = c.req.param("version") === "latest" ? secret.current_version : Number(c.req.param("version"));
  if (!Number.isInteger(wanted) || wanted < 1) return apiError(c, 400, "bad_request", "The version is a number from 1, or `latest`.");
  const version = await getVersion(c.env.DB, secret.id, wanted);
  if (!version) return apiError(c, 404, "not_found", `"${name.name}" has no version ${wanted}; the latest is ${secret.current_version}.`);
  if (version.destroyed_at) return apiError(c, 410, "destroyed", `Version ${wanted} of "${name.name}" was destroyed on ${version.destroyed_at}.`);
  if (version.key_version !== collection.key_version) {
    return apiError(c, 409, "key_rotated", `Version ${wanted} is still wrapped for key version ${version.key_version}; finish the rotation (\`artifact vault rotate ${collection.name}\`).`);
  }
  await audit(c, "vault.read", "vault_secret", secret.id, { collection: collection.name, name: name.name, version: wanted });
  return c.json<VaultVersionResponse>({
    collection: collection.name,
    secret: name.name,
    version: wanted,
    key_version: version.key_version,
    wrapped_dek: JSON.parse(version.wrapped_dek) as VaultEnvelope,
    ciphertext: JSON.parse(version.ciphertext) as VaultSealed,
    grant: readable.envelope,
    collection_public_key: collection.public_key,
  });
});

vault.delete("/collections/:name/secrets/:secret/versions/:version", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const secret = await secretByName(c.env.DB, loaded.collection.id, name.name);
  if (!secret) return apiError(c, 404, "not_found", `"${name.name}" is not in "${loaded.collection.name}".`);
  const wanted = Number(c.req.param("version"));
  if (!Number.isInteger(wanted) || wanted < 1) return apiError(c, 400, "bad_request", "The version is a number from 1.");
  const destroyed = await destroyVersion(c.env.DB, secret.id, wanted);
  if (destroyed) await audit(c, "vault.destroy", "vault_secret", secret.id, { collection: loaded.collection.name, name: name.name, version: wanted });
  return c.json({ destroyed, version: wanted });
});

vault.delete("/collections/:name/secrets/:secret", async (c) => {
  const loaded = await loadCollection(c);
  if (!loaded.ok) return loaded.res;
  const name = secretName(c);
  if (!name.ok) return name.res;
  const readable = await readableBy(c, loaded.collection, await callerMember(c));
  if (!readable.ok) return readable.res;
  const secret = await secretByName(c.env.DB, loaded.collection.id, name.name);
  if (!secret) return apiError(c, 404, "not_found", `"${name.name}" is not in "${loaded.collection.name}".`);
  await deleteSecret(c.env.DB, secret.id);
  await audit(c, "vault.secret_delete", "vault_secret", secret.id, { collection: loaded.collection.name, name: name.name, versions: secret.current_version });
  return c.json({ deleted: true });
});
