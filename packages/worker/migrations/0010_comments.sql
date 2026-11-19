-- Comments on a page: on the whole page, or on a passage of it (quote), with replies. The third
-- step of spaces. A person or an agent writes them; a thread is settled by resolving it.
create table comments (
  id text primary key,
  artifact_id text not null,
  version integer not null,      -- the version it was written on
  reply_to text,                 -- the comment that starts its thread; null starts one
  author_user text,              -- a person (users.id), or null
  author_device text,            -- an agent (devices.id), or null
  author_name text not null,     -- the name as it was when written
  body text not null,
  quote text,                    -- the passage it is about, as selected; null for the whole page
  resolved_at text,              -- for a thread's first comment: when the thread was settled
  created_at text not null
);
create index comments_artifact on comments (artifact_id, created_at);
