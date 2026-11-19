-- Search, links between pages and the text of each version: the second step of spaces. The CLI
-- reads a page's text and the pages it links to when it publishes; the Worker only stores them.
alter table versions add column text text;  -- the page's text as the CLI read it; null before 0009 or from an older CLI

-- The current version's text, searchable. trigram finds any 3 characters in a row, so Japanese,
-- which has no spaces between words, is found by any part of a word.
create virtual table page_text using fts5(id unindexed, title, description, body, tokenize = 'trigram');
insert into page_text (id, title, description, body) select id, title, coalesce(description, ''), '' from artifacts;

create table links (              -- what the current version of each page links to
  from_id text not null,
  to_id text not null,
  primary key (from_id, to_id)
);
create index links_to on links (to_id);
