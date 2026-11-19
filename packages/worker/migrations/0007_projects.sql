-- Projects: each page belongs to at most one, so the list can be narrowed to one project. The CLI
-- names a new page's project after the git repository it runs in; null means none.
alter table artifacts add column project text;
create index artifacts_project on artifacts (project, deleted_at, updated_at desc);
