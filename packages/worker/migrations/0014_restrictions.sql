-- Page restrictions: a page is open (as its project allows), restricted for editing ('edit': only
-- the people listed with can = 'edit' change it) or for viewing ('view': only the people listed
-- see it; those with can = 'edit' also change it). A restriction holds for the pages under it too.
alter table artifacts add column restriction text;
create table page_access (
  artifact_id text not null,
  user_id text not null references users(id) on delete cascade,
  can text not null,          -- view | edit
  primary key (artifact_id, user_id)
);
create index page_access_user on page_access (user_id);
