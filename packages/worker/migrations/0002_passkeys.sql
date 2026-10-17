-- People become users with passkeys. Google sign-in, when configured, signs in the user with
-- the matching email; viewers that were added by email are carried over.

create table users (
  id text primary key,
  name text not null,
  role text not null check (role in ('root', 'viewer')),
  email text unique,                   -- lower case; only for Google sign-in
  created_at text not null
);

create table passkeys (
  id text primary key,                 -- credential id, base64url
  user_id text not null references users (id) on delete cascade,
  public_key text not null,            -- COSE public key, base64url
  counter integer not null default 0,
  transports text,                     -- JSON array
  label text not null,
  created_at text not null,
  last_used_at text
);
create index passkeys_user on passkeys (user_id);

create table invites (
  token_hash text primary key,         -- sha256 of the token in the link
  role text not null check (role in ('root', 'viewer')),
  created_by text,                     -- user id; null for the owner link made at deploy time
  expires_at text not null,
  used_at text,
  used_by text
);

create table login_links (
  token_hash text primary key,
  user_id text not null references users (id) on delete cascade,
  next text not null,
  expires_at text not null,
  used_at text
);

insert into users (id, name, role, email, created_at)
  select lower(hex(randomblob(10))), email, 'viewer', email, added_at from members;
drop table members;

-- Sessions now belong to users; existing sessions end once.
drop table sessions;
create table sessions (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  csrf text not null,
  expires_at text not null
);
create index sessions_user on sessions (user_id);

-- The user who approved the device; `artifact open` signs in as them.
alter table devices add column user_id text references users (id) on delete set null;
