import type { Context } from "hono";
import type { AppEnv } from "../app-env.ts";
import { randomId } from "../lib/encoding.ts";

export type AuditActorType = "user" | "device" | "anonymous" | "system";
export type AuditResult = "success" | "denied" | "error";

export interface AuditEventRow {
  id: string;
  event_at: string;
  request_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  result: AuditResult;
  ip_address: string | null;
  user_agent: string | null;
  metadata: string | null;
}

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  result?: AuditResult;
  /** Non-secret context only. Tokens, codes, cookies and request bodies must never be included. */
  metadata?: Record<string, string | number | boolean | null>;
}

const MAX_LABEL_LENGTH = 128;
const MAX_USER_AGENT_LENGTH = 256;
const MAX_METADATA_LENGTH = 4096;
export const AUDIT_RETENTION_DAYS = 180;

function limited(value: string | undefined | null, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

/**
 * Appends a security audit event. Logging is best-effort so a temporary audit write failure never
 * repeats an action that already succeeded; the failure is still sent to the Worker log.
 */
export async function recordAuditEvent(c: Context<AppEnv>, input: AuditEventInput): Promise<void> {
  const serializedMetadata = input.metadata ? JSON.stringify(input.metadata) : null;
  const metadata = serializedMetadata && serializedMetadata.length <= MAX_METADATA_LENGTH
    ? serializedMetadata
    : serializedMetadata
      ? JSON.stringify({ truncated: true })
      : null;
  try {
    await c.env.DB.prepare(
      `insert into audit_events
       (id, event_at, request_id, actor_type, actor_id, actor_label, action, target_type, target_id, result, ip_address, user_agent, metadata)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        randomId(),
        new Date().toISOString(),
        limited(c.req.header("cf-ray"), MAX_LABEL_LENGTH) ?? randomId(),
        input.actorType,
        limited(input.actorId, MAX_LABEL_LENGTH),
        limited(input.actorLabel, MAX_LABEL_LENGTH),
        input.action,
        input.targetType,
        limited(input.targetId, MAX_LABEL_LENGTH),
        input.result ?? "success",
        limited(c.req.header("cf-connecting-ip"), MAX_LABEL_LENGTH),
        limited(c.req.header("user-agent"), MAX_USER_AGENT_LENGTH),
        metadata,
      )
      .run();
  } catch (error) {
    console.error("audit.write_failed", input.action, error instanceof Error ? error.message : String(error));
  }
}

export async function listRecentAuditEvents(db: D1Database, limit = 50): Promise<AuditEventRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const { results } = await db.prepare("select * from audit_events order by event_at desc limit ?").bind(safeLimit).all<AuditEventRow>();
  return results;
}
