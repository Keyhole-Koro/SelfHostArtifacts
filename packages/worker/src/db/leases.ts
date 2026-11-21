/** Leases of content tokens (see content.ts and migrations/0018_content_leases.sql). */

/** Keeps a leased content token serving until `exp` (unix seconds). */
export async function renewLease(db: D1Database, lease: string, exp: number): Promise<void> {
  await db
    .prepare("insert into content_leases (id, expires_at) values (?, ?) on conflict (id) do update set expires_at = excluded.expires_at")
    .bind(lease, new Date(exp * 1000).toISOString())
    .run();
}

export async function leaseLive(db: D1Database, lease: string, now = Date.now()): Promise<boolean> {
  const row = await db.prepare("select 1 from content_leases where id = ? and expires_at > ?").bind(lease, new Date(now).toISOString()).first();
  return row !== null;
}

export function leaseCleanup(db: D1Database, now: Date): D1PreparedStatement {
  return db.prepare("delete from content_leases where expires_at <= ?").bind(now.toISOString());
}
