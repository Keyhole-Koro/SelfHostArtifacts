-- Public links: anyone with /s/<id>/<key> can view the current version without signing in.
-- The key is an HMAC of the id and `share_nonce` under CONTENT_TOKEN_SECRET, so a copy of the
-- database alone does not reveal working links. Clearing the nonce turns the link off; a new
-- nonce makes a new link and kills the old one.
alter table artifacts add column share_nonce text;
alter table artifacts add column share_expires_at text;
