-- Who has a page open in the editor: each open editor says so every 20 seconds; a row older
-- than a minute no longer counts, and the daily cleanup drops it.
create table presence (
  artifact_id text not null,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  at text not null,
  primary key (artifact_id, user_id)
);
