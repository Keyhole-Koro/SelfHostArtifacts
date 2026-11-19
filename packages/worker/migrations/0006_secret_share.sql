-- Share mode of the secret handoff: the sender puts a ciphertext first (its key is after the # of
-- the link, which browsers never send), and the first browser that opens the link reads it. Until
-- then `ciphertext` holds that inner envelope; when the browser registers its public key, the
-- Worker wraps it for that key in the same update, so afterwards reading it needs the browser's
-- private key as well. `sealed_at` is set at that moment.
alter table secrets add column mode text not null default 'request' check (mode in ('request', 'share'));
