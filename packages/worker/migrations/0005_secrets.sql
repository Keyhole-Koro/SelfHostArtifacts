-- Secret handoff: the recipient's browser sends its public key, an agent puts a ciphertext made
-- for that key, and the browser decrypts it. The Worker never sees the plaintext. Only the sha256
-- of the link's token is stored, so the database alone does not reveal working links.
-- `created_by` has no foreign key on purpose: the record outlives a revoked device.
create table secrets (
  id text primary key,
  token_hash text not null unique,
  label text not null,
  created_by text not null,
  created_at text not null,
  expires_at text not null,
  claimed_at text,
  claim_ip text,
  claim_user_agent text,
  public_key text,
  sealed_at text,
  ciphertext text,
  opened_at text,
  finished_at text,
  finished_by text check (finished_by in ('recipient', 'owner', 'device', 'expiry'))
);
create index secrets_created on secrets (created_at desc);
