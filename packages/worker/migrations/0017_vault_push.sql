-- Delivery (`artifact vault push`): where each vault secret's value must go, and what was
-- delivered. Addresses name destinations (a Secret Manager secret, a CircleCI context variable,
-- a GitHub Actions secret, a Worker secret, a KEY in a file); they are not secret, but they map
-- the infrastructure, so only members with a grant on the collection may read them. Values and
-- destination credentials never pass through here: the device that opens the value delivers it.

create table vault_targets (
  id text primary key,
  secret_id text not null references vault_secrets (id),
  kind text not null check (kind in ('gcp', 'circleci', 'github', 'wrangler', 'envfile')),
  address text not null,               -- canonical <kind>://… string (see @artifact/shared vault-push.ts)
  plaintext_ok integer not null default 0,  -- envfile: the person accepted a plaintext copy on the device
  added_by text not null,              -- device id
  added_at text not null,
  removed_at text                      -- a removed target keeps its delivery records
);
create unique index vault_targets_live on vault_targets (secret_id, address) where removed_at is null;

create table vault_deliveries (
  id text primary key,
  target_id text not null references vault_targets (id),
  version integer not null,            -- the vault version that was delivered
  result text not null check (result in ('delivered', 'failed')),
  remote_ref text,                     -- what the destination called it (a Secret Manager version, an updated_at); never a value
  verified_at text,                    -- when the device read it back (or the destination confirmed it) and it matched
  delivered_at text not null,
  delivered_by text not null,          -- device id
  note text
);
create index vault_deliveries_target on vault_deliveries (target_id, delivered_at desc);
