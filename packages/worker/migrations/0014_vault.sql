-- The vault: secrets that only the owner's and the devices' keys can open. The Worker stores
-- ciphertexts, public keys and wrapped keys; it never holds a private key or a plaintext.
-- See docs/design.md, "金庫".
--
-- Keys, from the outside in: the recovery key (and later a passkey) wraps the owner key; the owner
-- key and each device's key wrap a collection key; the collection key wraps the data key of every
-- version; the data key encrypts the value. Adding a reader re-wraps one collection key, not every secret.

-- Who can hold a wrapped collection key: a device (its encryption key, next to its signing key) or
-- the owner (a key that lives only wrapped, opened by the recovery key or a passkey).
create table vault_members (
  id text primary key,
  kind text not null check (kind in ('device', 'owner')),
  device_id text,                      -- for kind = device. No foreign key: the record outlives a revoked device
  public_key text not null,            -- P-256, raw point in base64url
  created_at text not null,
  revoked_at text
);
create unique index vault_members_device on vault_members (device_id) where device_id is not null;

-- The owner key's private half, wrapped. `wrapped_by` is `recovery` or `passkey:<credential id>`.
create table vault_owner_key_wraps (
  member_id text not null references vault_members (id),
  wrapped_by text not null,
  envelope text not null,              -- JSON (see @artifact/shared vault.ts)
  created_at text not null,
  primary key (member_id, wrapped_by)
);

create table vault_collections (
  id text primary key,
  name text not null unique,
  public_key text not null,            -- the current collection key, P-256 raw point in base64url
  key_version integer not null,        -- grows when the key is replaced (a device was revoked)
  created_by text not null,            -- device id
  created_at text not null,
  updated_at text not null
);

-- The collection's private key, wrapped for each member. Old key versions stay until every
-- version of every secret is re-wrapped under the new key.
create table vault_grants (
  collection_id text not null references vault_collections (id),
  member_id text not null references vault_members (id),
  key_version integer not null,
  envelope text not null,
  granted_by text not null,            -- device id
  created_at text not null,
  primary key (collection_id, member_id, key_version)
);

create table vault_secrets (
  id text primary key,
  collection_id text not null references vault_collections (id),
  name text not null,
  description text,
  used_by text,                        -- the ledger: what reads this value (free text, not secret)
  current_version integer not null,
  created_at text not null,
  updated_at text not null,
  unique (collection_id, name)
);

create table vault_versions (
  secret_id text not null references vault_secrets (id),
  version integer not null,
  key_version integer not null,        -- which collection key wraps `wrapped_dek`
  wrapped_dek text not null,           -- the data key, wrapped for the collection key (envelope JSON)
  ciphertext text not null,            -- the value under the data key (AES-256-GCM, JSON)
  created_by text not null,            -- device id
  created_at text not null,
  destroyed_at text,                   -- set when the value was destroyed; wrapped_dek and ciphertext are then empty
  primary key (secret_id, version)
);
