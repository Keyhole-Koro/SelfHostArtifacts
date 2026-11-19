-- What happens on pages, who follows them, and what each person has not seen yet. Activity is
-- kept 180 days and notifications 90 (the daily cleanup).
create table activity (
  id text primary key,
  at text not null,
  artifact_id text not null,
  project text,               -- the page's project when it happened, for a project's feed
  kind text not null,         -- created | updated | commented | replied | resolved
  actor_user text,            -- a person (users.id), or
  actor_device text,          -- an agent (devices.id)
  actor_name text not null,
  version integer,            -- created, updated: the version it made
  comment_id text             -- commented, replied, resolved: the comment (for a reply, the thread's first)
);
create index activity_at on activity (at desc);
create index activity_project on activity (project, at desc);
create index activity_artifact on activity (artifact_id, at desc);

create table watches (        -- who follows a page or a whole project
  user_id text not null references users(id) on delete cascade,
  target text not null,       -- "a:<artifact id>" or "p:<project>"
  created_at text not null,
  primary key (user_id, target)
);

create table notifications (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  activity_id text not null,
  reason text not null,       -- mentioned | thread | watching
  read_at text,
  created_at text not null
);
create index notifications_user on notifications (user_id, read_at, created_at desc);
