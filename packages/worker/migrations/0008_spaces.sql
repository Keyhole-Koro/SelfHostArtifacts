-- A project is now a space: it has a description, its pages form a tree (parent, position), and the
-- owner can limit it to chosen viewers. A project with no row here is open to every viewer.
create table spaces (
  name text primary key,                    -- the project's name, as in artifacts.project
  description text,
  access text not null default 'everyone',  -- everyone | members
  created_at text not null
);

create table space_members (
  space text not null references spaces(name) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,                       -- viewer | editor
  primary key (space, user_id)
);
create index space_members_user on space_members (user_id);

alter table artifacts add column parent text;                          -- the page above it in the same project; null at the top
alter table artifacts add column position integer not null default 0;  -- order among pages with the same parent
create index artifacts_parent on artifacts (parent);

insert into spaces (name, created_at)
  select project, min(created_at) from artifacts where project is not null group by project;
