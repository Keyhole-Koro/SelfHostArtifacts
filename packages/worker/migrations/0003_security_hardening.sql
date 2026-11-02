-- Distinguish sessions created by a passkey (or an already-authenticated account) from the
-- intentionally lower-trust browser session created by a paired device. `device` is deliberately
-- the default: the old Worker remains live while this migration runs, and any row it inserts must
-- fail closed until the new Worker explicitly labels full sessions.
alter table sessions add column session_kind text not null default 'device'
  check (session_kind in ('full', 'device'));

-- Links only live for two minutes, so invalidate any made by the old code rather than treating a
-- device-created link as a full account session during a rolling deployment.
delete from login_links;
alter table login_links add column session_kind text not null default 'device'
  check (session_kind in ('full', 'device'));

-- An unowned device is valid only for first-owner bootstrap. Once an owner exists, old unowned
-- devices cannot be safely distinguished from devices left behind by a deleted user.
update devices
set revoked_at = coalesce(revoked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
where user_id is null and exists (select 1 from users where role = 'root');

-- Security-relevant actions. There are deliberately no foreign keys: deleting a user, device or
-- artifact must not erase its history. Application code only appends and the daily job expires old
-- rows after the documented retention period.
create table audit_events (
  id text primary key,
  event_at text not null,
  request_id text not null,
  actor_type text not null check (actor_type in ('user', 'device', 'anonymous', 'system')),
  actor_id text,
  actor_label text,
  action text not null,
  target_type text not null,
  target_id text,
  result text not null check (result in ('success', 'denied', 'error')),
  ip_address text,
  user_agent text,
  metadata text
);
create index audit_events_time on audit_events (event_at desc);
create index audit_events_action on audit_events (action, event_at desc);
