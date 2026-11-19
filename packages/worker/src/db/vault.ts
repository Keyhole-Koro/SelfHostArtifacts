import type { VaultDelivery, VaultEnvelope, VaultMember, VaultMemberKind, VaultOwner, VaultSealed, VaultSecretSummary, VaultTarget, VaultTargetKind, VaultVersionInfo } from "@artifact/shared";
import { randomId } from "../lib/encoding.ts";

/**
 * The vault's tables (migration 0016). Everything stored here is a public key, a wrapped key or a
 * ciphertext; see @artifact/shared vault.ts for the layers. Writes that must hold together (a
 * collection with its first grants, a key rotation) go through `db.batch`, which D1 runs as one
 * transaction.
 */

export interface MemberRow {
  id: string;
  kind: VaultMemberKind;
  device_id: string | null;
  public_key: string;
  created_at: string;
  revoked_at: string | null;
  /** From `devices`, when the member is a device. */
  device_name?: string | null;
}

export interface CollectionRow {
  id: string;
  name: string;
  public_key: string;
  key_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GrantRow {
  collection_id: string;
  member_id: string;
  key_version: number;
  envelope: string;
  granted_by: string;
  created_at: string;
}

export interface SecretRow {
  id: string;
  collection_id: string;
  name: string;
  description: string | null;
  used_by: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  secret_id: string;
  version: number;
  key_version: number;
  wrapped_dek: string;
  ciphertext: string;
  created_by: string;
  created_at: string;
  destroyed_at: string | null;
}

const now = () => new Date().toISOString();

const MEMBER_COLUMNS = "m.id, m.kind, m.device_id, m.public_key, m.created_at, m.revoked_at, d.name as device_name";

export function memberView(row: MemberRow): VaultMember {
  return {
    id: row.id,
    kind: row.kind,
    device_id: row.device_id,
    device_name: row.device_name ?? null,
    public_key: row.public_key,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

// ---- members ----

export function memberByDevice(db: D1Database, deviceId: string): Promise<MemberRow | null> {
  return db.prepare(`select ${MEMBER_COLUMNS} from vault_members m left join devices d on d.id = m.device_id where m.device_id = ?`).bind(deviceId).first<MemberRow>();
}

export function getMember(db: D1Database, id: string): Promise<MemberRow | null> {
  return db.prepare(`select ${MEMBER_COLUMNS} from vault_members m left join devices d on d.id = m.device_id where m.id = ?`).bind(id).first<MemberRow>();
}

export async function listMembers(db: D1Database): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(`select ${MEMBER_COLUMNS} from vault_members m left join devices d on d.id = m.device_id order by m.kind desc, m.created_at`)
    .all<MemberRow>();
  return results;
}

export function ownerMember(db: D1Database): Promise<MemberRow | null> {
  return db.prepare(`select ${MEMBER_COLUMNS} from vault_members m left join devices d on d.id = m.device_id where m.kind = 'owner' and m.revoked_at is null`).first<MemberRow>();
}

/**
 * Registers (or replaces) the encryption key of a device. A replaced key cannot open the grants
 * made for the old one, so those are dropped: the device needs new grants. Returns whether it was new.
 */
export async function upsertDeviceMember(db: D1Database, deviceId: string, publicKey: string): Promise<{ member: MemberRow; created: boolean; keyChanged: boolean }> {
  const existing = await memberByDevice(db, deviceId);
  if (!existing) {
    const id = randomId();
    await db.prepare("insert into vault_members (id, kind, device_id, public_key, created_at) values (?, 'device', ?, ?, ?)").bind(id, deviceId, publicKey, now()).run();
    return { member: (await getMember(db, id))!, created: true, keyChanged: false };
  }
  if (existing.public_key === publicKey && existing.revoked_at === null) return { member: existing, created: false, keyChanged: false };
  await db.batch([
    db.prepare("delete from vault_grants where member_id = ?").bind(existing.id),
    db.prepare("update vault_members set public_key = ?, revoked_at = null, created_at = ? where id = ?").bind(publicKey, now(), existing.id),
  ]);
  return { member: (await getMember(db, existing.id))!, created: false, keyChanged: true };
}

export async function revokeMembersOfDevice(db: D1Database, deviceId: string): Promise<void> {
  await db.prepare("update vault_members set revoked_at = ? where device_id = ? and revoked_at is null").bind(now(), deviceId).run();
}

// ---- the owner key ----

export interface OwnerWrapRow {
  member_id: string;
  wrapped_by: string;
  envelope: string;
  created_at: string;
}

/** Creates the owner member with its wraps, or adds wraps to the existing owner key. */
export async function setOwner(db: D1Database, publicKey: string, wraps: { wrapped_by: string; envelope: VaultSealed }[]): Promise<{ owner: MemberRow; created: boolean }> {
  const existing = await ownerMember(db);
  const id = existing?.id ?? randomId();
  const t = now();
  const statements: D1PreparedStatement[] = [];
  if (!existing) statements.push(db.prepare("insert into vault_members (id, kind, public_key, created_at) values (?, 'owner', ?, ?)").bind(id, publicKey, t));
  for (const wrap of wraps) {
    statements.push(
      db.prepare("insert into vault_owner_key_wraps (member_id, wrapped_by, envelope, created_at) values (?, ?, ?, ?) on conflict (member_id, wrapped_by) do update set envelope = excluded.envelope, created_at = excluded.created_at")
        .bind(id, wrap.wrapped_by, JSON.stringify(wrap.envelope), t),
    );
  }
  await db.batch(statements);
  return { owner: (await getMember(db, id))!, created: !existing };
}

export async function ownerView(db: D1Database): Promise<VaultOwner | null> {
  const owner = await ownerMember(db);
  if (!owner) return null;
  const { results } = await db.prepare("select * from vault_owner_key_wraps where member_id = ? order by created_at").bind(owner.id).all<OwnerWrapRow>();
  return {
    member_id: owner.id,
    public_key: owner.public_key,
    wraps: results.map((w) => ({ wrapped_by: w.wrapped_by, envelope: JSON.parse(w.envelope) as VaultSealed, created_at: w.created_at })),
  };
}

// ---- collections and grants ----

export function collectionByName(db: D1Database, name: string): Promise<CollectionRow | null> {
  return db.prepare("select * from vault_collections where name = ?").bind(name).first<CollectionRow>();
}

export async function createCollection(
  db: D1Database,
  input: { name: string; publicKey: string; createdBy: string; grants: { member_id: string; envelope: VaultEnvelope }[] },
): Promise<CollectionRow> {
  const id = randomId();
  const t = now();
  await db.batch([
    db.prepare("insert into vault_collections (id, name, public_key, key_version, created_by, created_at, updated_at) values (?, ?, ?, 1, ?, ?, ?)").bind(id, input.name, input.publicKey, input.createdBy, t, t),
    ...input.grants.map((g) =>
      db.prepare("insert into vault_grants (collection_id, member_id, key_version, envelope, granted_by, created_at) values (?, ?, 1, ?, ?, ?)").bind(id, g.member_id, JSON.stringify(g.envelope), input.createdBy, t),
    ),
  ]);
  return (await collectionByName(db, input.name))!;
}

export interface CollectionListRow extends CollectionRow {
  members: number;
  secrets: number;
  readable: number;
}

/** Collections with, for `memberId`, whether it holds a grant for the current key. */
export async function listCollections(db: D1Database, memberId: string | null): Promise<CollectionListRow[]> {
  const { results } = await db
    .prepare(
      `select c.*,
         (select count(*) from vault_grants g join vault_members m on m.id = g.member_id where g.collection_id = c.id and g.key_version = c.key_version and m.revoked_at is null) as members,
         (select count(*) from vault_secrets s where s.collection_id = c.id) as secrets,
         (select count(*) from vault_grants g where g.collection_id = c.id and g.key_version = c.key_version and g.member_id = ?) as readable
       from vault_collections c order by c.name`,
    )
    .bind(memberId ?? "")
    .all<CollectionListRow>();
  return results;
}

export function getGrant(db: D1Database, collectionId: string, memberId: string, keyVersion: number): Promise<GrantRow | null> {
  return db
    .prepare("select * from vault_grants where collection_id = ? and member_id = ? and key_version = ?")
    .bind(collectionId, memberId, keyVersion)
    .first<GrantRow>();
}

/** Members (not revoked) holding a grant for the collection's current key. */
export async function grantedMembers(db: D1Database, collection: CollectionRow): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(
      `select ${MEMBER_COLUMNS} from vault_grants g join vault_members m on m.id = g.member_id left join devices d on d.id = m.device_id
       where g.collection_id = ? and g.key_version = ? and m.revoked_at is null order by m.kind desc, m.created_at`,
    )
    .bind(collection.id, collection.key_version)
    .all<MemberRow>();
  return results;
}

export async function addGrant(db: D1Database, collection: CollectionRow, memberId: string, envelope: VaultEnvelope, grantedBy: string): Promise<void> {
  await db
    .prepare(
      `insert into vault_grants (collection_id, member_id, key_version, envelope, granted_by, created_at) values (?, ?, ?, ?, ?, ?)
       on conflict (collection_id, member_id, key_version) do update set envelope = excluded.envelope, granted_by = excluded.granted_by, created_at = excluded.created_at`,
    )
    .bind(collection.id, memberId, collection.key_version, JSON.stringify(envelope), grantedBy, now())
    .run();
}

/** Drops every grant of a member on a collection (all key versions). True when there was one. */
export async function removeGrants(db: D1Database, collectionId: string, memberId: string): Promise<boolean> {
  const r = await db.prepare("delete from vault_grants where collection_id = ? and member_id = ?").bind(collectionId, memberId).run();
  return (r.meta.changes ?? 0) > 0;
}

export interface LiveVersion {
  secret: string;
  secret_id: string;
  version: number;
  key_version: number;
  wrapped_dek: string;
}

/** Every version that still holds a value, with the key version that wraps its data key. */
export async function liveVersions(db: D1Database, collectionId: string): Promise<LiveVersion[]> {
  const { results } = await db
    .prepare(
      `select s.name as secret, v.secret_id, v.version, v.key_version, v.wrapped_dek
       from vault_versions v join vault_secrets s on s.id = v.secret_id
       where s.collection_id = ? and v.destroyed_at is null order by s.name, v.version`,
    )
    .bind(collectionId)
    .all<LiveVersion>();
  return results;
}

/**
 * Replaces the collection key: new public key and key version, the grants of the members that
 * keep access, and every live version's data key wrapped again. One transaction; it applies only
 * while the collection is still at `fromKeyVersion`, so two rotations cannot interleave.
 */
export async function rotateCollection(
  db: D1Database,
  collection: CollectionRow,
  input: { keyVersion: number; publicKey: string; grants: { member_id: string; envelope: VaultEnvelope }[]; versions: { secret_id: string; version: number; wrapped_dek: VaultEnvelope }[]; by: string },
): Promise<boolean> {
  const t = now();
  const results = await db.batch([
    db.prepare("update vault_collections set public_key = ?, key_version = ?, updated_at = ? where id = ? and key_version = ?")
      .bind(input.publicKey, input.keyVersion, t, collection.id, collection.key_version),
    db.prepare("delete from vault_grants where collection_id = ?").bind(collection.id),
    ...input.grants.map((g) =>
      db.prepare("insert into vault_grants (collection_id, member_id, key_version, envelope, granted_by, created_at) values (?, ?, ?, ?, ?, ?)")
        .bind(collection.id, g.member_id, input.keyVersion, JSON.stringify(g.envelope), input.by, t),
    ),
    ...input.versions.map((v) =>
      db.prepare("update vault_versions set key_version = ?, wrapped_dek = ? where secret_id = ? and version = ? and destroyed_at is null")
        .bind(input.keyVersion, JSON.stringify(v.wrapped_dek), v.secret_id, v.version),
    ),
  ]);
  // The first statement is the guard: nothing changed means another rotation won.
  return (results[0]?.meta.changes ?? 0) > 0;
}

// ---- secrets and versions ----

export function secretByName(db: D1Database, collectionId: string, name: string): Promise<SecretRow | null> {
  return db.prepare("select * from vault_secrets where collection_id = ? and name = ?").bind(collectionId, name).first<SecretRow>();
}

export interface SecretListRow extends SecretRow {
  live_versions: number;
}

export async function listSecrets(db: D1Database, collectionId: string): Promise<SecretListRow[]> {
  const { results } = await db
    .prepare(
      `select s.*, (select count(*) from vault_versions v where v.secret_id = s.id and v.destroyed_at is null) as live_versions
       from vault_secrets s where s.collection_id = ? order by s.name`,
    )
    .bind(collectionId)
    .all<SecretListRow>();
  return results;
}

export function secretSummary(row: SecretListRow): VaultSecretSummary {
  return {
    name: row.name,
    description: row.description,
    used_by: row.used_by,
    current_version: row.current_version,
    live_versions: row.live_versions,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Adds version `version` of a secret, creating the secret on version 1. The caller says which
 * version it encrypted for (the version is part of the additional data), so this applies only when
 * that is the next one; false means someone else put a version first.
 */
export async function putVersion(
  db: D1Database,
  input: {
    collectionId: string;
    name: string;
    version: number;
    description?: string | undefined;
    usedBy?: string | undefined;
    keyVersion: number;
    wrappedDek: VaultEnvelope;
    ciphertext: VaultSealed;
    createdBy: string;
  },
): Promise<{ ok: true; secret: SecretRow } | { ok: false; current: number }> {
  const existing = await secretByName(db, input.collectionId, input.name);
  const t = now();
  const expected = (existing?.current_version ?? 0) + 1;
  if (input.version !== expected) return { ok: false, current: existing?.current_version ?? 0 };
  const id = existing?.id ?? randomId();
  const secretStatement = existing
    ? db.prepare(
        `update vault_secrets set current_version = ?, updated_at = ?,
           description = coalesce(?, description), used_by = coalesce(?, used_by)
         where id = ? and current_version = ?`,
      ).bind(input.version, t, input.description ?? null, input.usedBy ?? null, id, existing.current_version)
    : db.prepare("insert into vault_secrets (id, collection_id, name, description, used_by, current_version, created_at, updated_at) values (?, ?, ?, ?, ?, 1, ?, ?)")
      .bind(id, input.collectionId, input.name, input.description ?? null, input.usedBy ?? null, t, t);
  const results = await db.batch([
    secretStatement,
    db.prepare("insert into vault_versions (secret_id, version, key_version, wrapped_dek, ciphertext, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.version, input.keyVersion, JSON.stringify(input.wrappedDek), JSON.stringify(input.ciphertext), input.createdBy, t),
  ]);
  if (existing && (results[0]?.meta.changes ?? 0) === 0) {
    // The guard failed: the batch is rolled back as a whole, so the version row was not kept either.
    const latest = await secretByName(db, input.collectionId, input.name);
    return { ok: false, current: latest?.current_version ?? 0 };
  }
  return { ok: true, secret: (await secretByName(db, input.collectionId, input.name))! };
}

export async function updateSecretLedger(db: D1Database, secretId: string, patch: { description?: string | null | undefined; usedBy?: string | null | undefined }): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const binds: (string | null)[] = [now()];
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.usedBy !== undefined) {
    sets.push("used_by = ?");
    binds.push(patch.usedBy);
  }
  await db.prepare(`update vault_secrets set ${sets.join(", ")} where id = ?`).bind(...binds, secretId).run();
}

export function getVersion(db: D1Database, secretId: string, version: number): Promise<VersionRow | null> {
  return db.prepare("select * from vault_versions where secret_id = ? and version = ?").bind(secretId, version).first<VersionRow>();
}

export async function listVersions(db: D1Database, secretId: string): Promise<VaultVersionInfo[]> {
  const { results } = await db
    .prepare("select version, key_version, created_by, created_at, destroyed_at from vault_versions where secret_id = ? order by version desc")
    .bind(secretId)
    .all<VaultVersionInfo>();
  return results;
}

/** Destroys one version's value for good (the row stays, empty). True when it still had a value. */
export async function destroyVersion(db: D1Database, secretId: string, version: number): Promise<boolean> {
  const r = await db
    .prepare("update vault_versions set wrapped_dek = '', ciphertext = '', destroyed_at = ? where secret_id = ? and version = ? and destroyed_at is null")
    .bind(now(), secretId, version)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function deleteSecret(db: D1Database, secretId: string): Promise<void> {
  await db.batch([
    db.prepare("delete from vault_versions where secret_id = ?").bind(secretId),
    db.prepare("delete from vault_secrets where id = ?").bind(secretId),
  ]);
}

// ---- delivery targets and records (migration 0017) ----

export interface TargetRow {
  id: string;
  secret_id: string;
  kind: VaultTargetKind;
  address: string;
  plaintext_ok: number;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

export interface DeliveryRow {
  id: string;
  target_id: string;
  version: number;
  result: "delivered" | "failed";
  remote_ref: string | null;
  verified_at: string | null;
  delivered_at: string;
  delivered_by: string;
  note: string | null;
}

export function getTarget(db: D1Database, id: string): Promise<TargetRow | null> {
  return db.prepare("select * from vault_targets where id = ?").bind(id).first<TargetRow>();
}

/** Adds a target, or returns the live one with the same address (adding twice is harmless). */
export async function addTarget(db: D1Database, input: { secretId: string; kind: VaultTargetKind; address: string; plaintextOk: boolean; addedBy: string }): Promise<{ target: TargetRow; created: boolean }> {
  const existing = await db.prepare("select * from vault_targets where secret_id = ? and address = ? and removed_at is null").bind(input.secretId, input.address).first<TargetRow>();
  if (existing) return { target: existing, created: false };
  const id = randomId();
  await db
    .prepare("insert into vault_targets (id, secret_id, kind, address, plaintext_ok, added_by, added_at) values (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.secretId, input.kind, input.address, input.plaintextOk ? 1 : 0, input.addedBy, now())
    .run();
  return { target: (await getTarget(db, id))!, created: true };
}

/** Marks a target removed; its delivery records stay. True when it was live. */
export async function removeTarget(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("update vault_targets set removed_at = ? where id = ? and removed_at is null").bind(now(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

export async function targetsOfSecret(db: D1Database, secretId: string): Promise<TargetRow[]> {
  const { results } = await db.prepare("select * from vault_targets where secret_id = ? and removed_at is null order by added_at").bind(secretId).all<TargetRow>();
  return results;
}

export interface CollectionTargetRow extends TargetRow {
  secret_name: string;
}

export async function targetsOfCollection(db: D1Database, collectionId: string): Promise<CollectionTargetRow[]> {
  const { results } = await db
    .prepare(
      `select t.*, s.name as secret_name from vault_targets t join vault_secrets s on s.id = t.secret_id
       where s.collection_id = ? and t.removed_at is null order by s.name, t.added_at`,
    )
    .bind(collectionId)
    .all<CollectionTargetRow>();
  return results;
}

export interface DeliverySummary {
  latest: DeliveryRow | null;
  delivered: DeliveryRow | null;
}

/** For each target, the newest record and the newest successful one. */
export async function deliverySummaries(db: D1Database, targetIds: string[]): Promise<Map<string, DeliverySummary>> {
  const out = new Map<string, DeliverySummary>();
  for (const id of targetIds) out.set(id, { latest: null, delivered: null });
  for (let i = 0; i < targetIds.length; i += 90) {
    const chunk = targetIds.slice(i, i + 90);
    const { results } = await db
      .prepare(`select * from vault_deliveries where target_id in (${chunk.map(() => "?").join(", ")}) order by delivered_at desc, id desc`)
      .bind(...chunk)
      .all<DeliveryRow>();
    for (const row of results) {
      const entry = out.get(row.target_id)!;
      if (!entry.latest) entry.latest = row;
      if (!entry.delivered && row.result === "delivered") entry.delivered = row;
    }
  }
  return out;
}

export async function recordDelivery(
  db: D1Database,
  input: { targetId: string; version: number; result: "delivered" | "failed"; remoteRef?: string | undefined; verified?: boolean | undefined; note?: string | undefined; deliveredBy: string },
): Promise<DeliveryRow> {
  const id = randomId();
  const t = now();
  await db
    .prepare("insert into vault_deliveries (id, target_id, version, result, remote_ref, verified_at, delivered_at, delivered_by, note) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.targetId, input.version, input.result, input.remoteRef ?? null, input.verified && input.result === "delivered" ? t : null, t, input.deliveredBy, input.note ?? null)
    .run();
  return (await db.prepare("select * from vault_deliveries where id = ?").bind(id).first<DeliveryRow>())!;
}

export function deliveryView(row: DeliveryRow): VaultDelivery {
  return {
    id: row.id,
    version: row.version,
    result: row.result,
    remote_ref: row.remote_ref,
    verified_at: row.verified_at,
    delivered_at: row.delivered_at,
    delivered_by: row.delivered_by,
    note: row.note,
  };
}

export function targetView(row: TargetRow, summary: DeliverySummary | undefined): VaultTarget {
  return {
    id: row.id,
    kind: row.kind,
    address: row.address,
    plaintext_ok: row.plaintext_ok === 1,
    added_by: row.added_by,
    added_at: row.added_at,
    removed_at: row.removed_at,
    latest: summary?.latest ? deliveryView(summary.latest) : null,
    delivered: summary?.delivered ? deliveryView(summary.delivered) : null,
  };
}
