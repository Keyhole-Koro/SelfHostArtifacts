import type { Role } from "../app-env.ts";
import { randomBase32, randomToken, sha256Hex } from "../lib/encoding.ts";

export interface UserRow {
  id: string;
  name: string;
  role: Role;
  /** Unused since Google sign-in was removed; kept because SQLite cannot drop a UNIQUE column. */
  email: string | null;
  created_at: string;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export function newUserId(): string {
  return randomBase32(20);
}

export async function getUser(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare("select * from users where id = ?").bind(id).first<UserRow>();
}

export async function listUsers(db: D1Database): Promise<(UserRow & { passkeys: number })[]> {
  const { results } = await db
    .prepare(
      `select u.*, (select count(*) from passkeys p where p.user_id = u.id) as passkeys
       from users u order by case u.role when 'root' then 0 else 1 end, u.created_at`,
    )
    .all<UserRow & { passkeys: number }>();
  return results;
}

export async function firstRoot(db: D1Database): Promise<UserRow | null> {
  return db.prepare("select * from users where role = 'root' order by created_at limit 1").first<UserRow>();
}

export async function createUser(db: D1Database, user: { name: string; role: Role }): Promise<UserRow> {
  const row: UserRow = {
    id: newUserId(),
    name: user.name,
    role: user.role,
    email: null,
    created_at: new Date().toISOString(),
  };
  await db
    .prepare("insert into users (id, name, role, email, created_at) values (?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.role, row.email, row.created_at)
    .run();
  return row;
}

/** Deleting a user also deletes their passkeys, sessions and login links (foreign keys cascade). */
export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("delete from passkeys where user_id = ?").bind(id),
    db.prepare("delete from sessions where user_id = ?").bind(id),
    db.prepare("delete from login_links where user_id = ?").bind(id),
    db.prepare("update devices set user_id = null where user_id = ?").bind(id),
    db.prepare("delete from users where id = ?").bind(id),
  ]);
}

export async function listPasskeys(db: D1Database, userId: string): Promise<PasskeyRow[]> {
  const { results } = await db.prepare("select * from passkeys where user_id = ? order by created_at").bind(userId).all<PasskeyRow>();
  return results;
}

export async function getPasskey(db: D1Database, credentialId: string): Promise<PasskeyRow | null> {
  return db.prepare("select * from passkeys where id = ?").bind(credentialId).first<PasskeyRow>();
}

export function insertPasskey(
  db: D1Database,
  p: { id: string; userId: string; publicKey: string; counter: number; transports: string[] | undefined; label: string },
): D1PreparedStatement {
  return db
    .prepare("insert into passkeys (id, user_id, public_key, counter, transports, label, created_at) values (?, ?, ?, ?, ?, ?, ?)")
    .bind(p.id, p.userId, p.publicKey, p.counter, p.transports ? JSON.stringify(p.transports) : null, p.label, new Date().toISOString());
}

// --- Invites: single-use links that let someone create a user with a passkey ---

export const INVITE_DAYS = 7;

export interface InviteRow {
  token_hash: string;
  role: Role;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
}

/** Creates an invite and returns its token. Only the hash is stored. */
export async function createInvite(db: D1Database, role: Role, createdBy: string | null, days = INVITE_DAYS): Promise<string> {
  const token = randomToken();
  await db
    .prepare("insert into invites (token_hash, role, created_by, expires_at) values (?, ?, ?, ?)")
    .bind(await sha256Hex(token), role, createdBy, new Date(Date.now() + days * 864e5).toISOString())
    .run();
  return token;
}

export async function openInvite(db: D1Database, token: string): Promise<InviteRow | null> {
  const row = await db.prepare("select * from invites where token_hash = ?").bind(await sha256Hex(token)).first<InviteRow>();
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

export async function listOpenInvites(db: D1Database): Promise<InviteRow[]> {
  const { results } = await db
    .prepare("select * from invites where used_at is null and expires_at > ? order by expires_at")
    .bind(new Date().toISOString())
    .all<InviteRow>();
  return results;
}

/** Marks the invite used; false when someone used it first. */
export function useInvite(db: D1Database, tokenHash: string, userId: string): D1PreparedStatement {
  return db
    .prepare("update invites set used_at = ?, used_by = ? where token_hash = ? and used_at is null and expires_at > ?")
    .bind(new Date().toISOString(), userId, tokenHash, new Date().toISOString());
}

// --- Login links: single-use, short-lived links made by `artifact open` ---

export const LOGIN_LINK_SECONDS = 120;

export async function createLoginLink(db: D1Database, userId: string, next: string): Promise<string> {
  const token = randomToken();
  await db
    .prepare("insert into login_links (token_hash, user_id, next, expires_at) values (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, next, new Date(Date.now() + LOGIN_LINK_SECONDS * 1000).toISOString())
    .run();
  return token;
}

/** Consumes a login link; returns its user and destination, or null if used or expired. */
export async function consumeLoginLink(db: D1Database, token: string): Promise<{ userId: string; next: string } | null> {
  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await db
    .prepare("update login_links set used_at = ? where token_hash = ? and used_at is null and expires_at > ? returning user_id, next")
    .bind(now, hash, now)
    .first<{ user_id: string; next: string }>();
  return row ? { userId: row.user_id, next: row.next } : null;
}
