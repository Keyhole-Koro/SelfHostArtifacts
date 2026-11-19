-- Search by meaning, the fourth step of spaces. Each page's text is cut into passages that Workers
-- AI embeds into a Vectorize index under the ids "<artifact id>:<n>". These tables say what the
-- index holds, so a page is embedded again only when its version changes.
create table page_chunks (
  artifact_id text not null,
  n integer not null,
  text text not null,
  primary key (artifact_id, n)
);

create table page_vectors (
  artifact_id text primary key,
  version integer not null,   -- the version whose text the vectors hold
  chunks integer not null,
  indexed_at text not null
);
