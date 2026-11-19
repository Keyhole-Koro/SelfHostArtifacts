import type { SecretMode, SecretStatus, SecretSummary } from "@artifact/shared";

export interface SecretRow {
  id: string;
  mode: SecretMode;
  token_hash: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  claim_ip: string | null;
  claim_user_agent: string | null;
  public_key: string | null;
  sealed_at: string | null;
  ciphertext: string | null;
  opened_at: string | null;
  finished_at: string | null;
  finished_by: "recipient" | "owner" | "device" | "expiry" | null;
}

export type SecretFinisher = "recipient" | "owner" | "device";

/** Finished and expired requests stay listed (without any key material) for this long. */
export const SECRET_HISTORY_DAYS = 30;

export function secretStatus(row: SecretRow, now = Date.now()): SecretStatus {
  if (row.finished_by === "recipient") return "received";
  if (row.finished_by === "owner" || row.finished_by === "device") return "deleted";
  if (row.finished_by === "expiry" || Date.parse(row.expires_at) <= now) return "expired";
  if (row.sealed_at) return "sealed";
  if (row.claimed_at) return "claimed";
  return "waiting";
}

/** True while the link still works: not finished and not expired. */
export function secretOpen(row: SecretRow, now = Date.now()): boolean {
  return row.finished_at === null && Date.parse(row.expires_at) > now;
}

export function secretSummary(row: SecretRow, now = Date.now()): SecretSummary {
  return {
    id: row.id,
    mode: row.mode,
    label: row.label,
    status: secretStatus(row, now),
    created_at: row.created_at,
    expires_at: row.expires_at,
    claimed_at: row.claimed_at,
    claim_ip: row.claim_ip,
    claim_user_agent: row.claim_user_agent,
    public_key: row.public_key,
    sealed_at: row.sealed_at,
    opened_at: row.opened_at,
    finished_at: row.finished_at,
  };
}

/** In share mode, `ciphertext` is the inner envelope that only the link's secret opens. */
export async function createSecret(
  db: D1Database,
  input: { id: string; tokenHash: string; label: string; deviceId: string; expiresAt: string; mode?: SecretMode; ciphertext?: string },
): Promise<void> {
  await db
    .prepare("insert into secrets (id, mode, token_hash, label, created_by, created_at, expires_at, ciphertext) values (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(input.id, input.mode ?? "request", input.tokenHash, input.label, input.deviceId, new Date().toISOString(), input.expiresAt, input.ciphertext ?? null)
    .run();
}

export function getSecret(db: D1Database, id: string): Promise<SecretRow | null> {
  return db.prepare("select * from secrets where id = ?").bind(id).first<SecretRow>();
}

export function secretByTokenHash(db: D1Database, tokenHash: string): Promise<SecretRow | null> {
  return db.prepare("select * from secrets where token_hash = ?").bind(tokenHash).first<SecretRow>();
}

export async function listSecrets(db: D1Database, limit = 50): Promise<SecretRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const { results } = await db.prepare("select * from secrets order by created_at desc limit ?").bind(safeLimit).all<SecretRow>();
  return results;
}

/** Request mode: records the recipient's public key. Only the first browser wins; false when it was too late. */
export async function claimSecret(db: D1Database, id: string, publicKey: string, ip: string | null, userAgent: string | null): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await db
    .prepare(
      `update secrets set claimed_at = ?, public_key = ?, claim_ip = ?, claim_user_agent = ?
       where id = ? and mode = 'request' and claimed_at is null and finished_at is null and expires_at > ?`,
    )
    .bind(now, publicKey, ip, userAgent?.slice(0, 256) ?? null, id, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Share mode: records the first browser and, in the same update, replaces the inner envelope with
 * `wrapped` (the inner envelope encrypted for that browser). The update only applies while the row
 * still holds exactly `inner`, so two browsers cannot both win. False when it was too late.
 */
export async function claimShare(
  db: D1Database,
  input: { id: string; inner: string; wrapped: string; publicKey: string; ip: string | null; userAgent: string | null },
): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await db
    .prepare(
      `update secrets set claimed_at = ?, sealed_at = ?, public_key = ?, claim_ip = ?, claim_user_agent = ?, ciphertext = ?
       where id = ? and mode = 'share' and claimed_at is null and finished_at is null and expires_at > ? and ciphertext = ?`,
    )
    .bind(now, now, input.publicKey, input.ip, input.userAgent?.slice(0, 256) ?? null, input.wrapped, input.id, now, input.inner)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Stores the ciphertext once, after a claim. False when it is not claimed, already sealed, finished or expired. */
export async function sealSecret(db: D1Database, id: string, ciphertext: string): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await db
    .prepare(
      `update secrets set sealed_at = ?, ciphertext = ?
       where id = ? and mode = 'request' and claimed_at is not null and sealed_at is null and finished_at is null and expires_at > ?`,
    )
    .bind(now, ciphertext, id, now)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Notes the first time the recipient fetched the ciphertext. True only the first time. */
export async function markSecretOpened(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("update secrets set opened_at = ? where id = ? and opened_at is null").bind(new Date().toISOString(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Ends the request and drops the ciphertext. False when it had already ended. */
export async function finishSecret(db: D1Database, id: string, by: SecretFinisher): Promise<boolean> {
  const r = await db
    .prepare("update secrets set ciphertext = null, finished_at = ?, finished_by = ? where id = ? and finished_at is null")
    .bind(new Date().toISOString(), by, id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}
