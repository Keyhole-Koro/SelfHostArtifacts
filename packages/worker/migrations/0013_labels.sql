-- Labels on pages: free words that cut across projects and the tree ("decision", "draft",
-- "template"). A label is lower case, without spaces.
create table labels (
  artifact_id text not null,
  label text not null,
  primary key (artifact_id, label)
);
create index labels_label on labels (label);
