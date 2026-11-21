-- The frame of a viewer page (and of a public link's page) keeps its /c/<token>/ URL while the
-- page is open: the token runs out after ten minutes, but the page renews the token's lease
-- before then, and a run-out token whose lease has not ended still serves. So the page in the
-- frame is never reloaded for a new token. A token without a lease ends at its own expiry. The
-- row is written at the first renewal; the daily cleanup drops ended ones.
create table content_leases (
  id text primary key,
  expires_at text not null
);
