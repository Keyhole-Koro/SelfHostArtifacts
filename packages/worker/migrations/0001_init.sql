-- Times are ISO 8601 strings in UTC.

create table artifacts (
  id text primary key,                 -- random base32, the :id in /a/:id
  title text not null,
  description text,
  current_version integer not null,
  created_at text not null,
  updated_at text not null,
  deleted_at text                      -- in the trash since; purged after TRASH_DAYS
);
create index artifacts_updated on artifacts (deleted_at, updated_at desc);

create table versions (
  artifact_id text not null references artifacts (id) on delete cascade,
  version integer not null,
  entry text not null,
  files text not null,                 -- JSON: { path: { sha256, size, type } }
  allow_connect text,                  -- JSON array of hostnames, or null
  created_by text not null,            -- device id
  created_at text not null,
  primary key (artifact_id, version)
);

create table devices (
  id text primary key,
  name text not null,
  public_key text not null,            -- raw Ed25519 public key, base64url
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create table pairings (
  code text primary key,
  name text not null,
  public_key text not null,
  requested_ip text,
  status text not null default 'pending', -- pending | approved | denied
  device_id text,
  expires_at text not null
);

create table members (
  email text primary key,              -- lower case; root is not stored here
  added_at text not null
);

create table sessions (
  id text primary key,
  email text not null,
  csrf text not null,
  expires_at text not null
);
create index sessions_email on sessions (email);

create table nonces (
  nonce text primary key,
  expires_at text not null
);
