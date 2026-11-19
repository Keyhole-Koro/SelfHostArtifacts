---
name: selfhost-artifact-publish
description: When and how to publish, update, read or delete pages with the artifact MCP tools (publish, read, list, delete) or the `artifact` CLI. Use when the user wants something as a web page, link or shareable page, or asks to change a page published earlier.
---

# Publishing with `artifact`

`artifact` publishes a local HTML page to the user's own private site and returns a URL such as
`https://artifacts.example.com/a/x7k2m9q4p1r8t3v6`. Only the owner and the viewers they added
can open it.

## When to publish

- The user asks for a page, report, dashboard, chart or anything "to open in the browser".
- The result is clearer as a page than as terminal text (a table that is too wide, a chart, a
  long document they will come back to), and the user would want the link. Say in one line that
  you can publish it if they did not ask.
- Not for content the user marked as sensitive, and never for secrets or credentials.

Read the selfhost-artifact-design skill before writing the page.

## Publish

MCP: `publish({ file_path, title?, description?, files?, url?, allow_connect?, project?, parent?, labels? })`
CLI: `artifact publish <file.html|folder> [--title …] [--description …] [--labels a,b]`

- `file_path` is the absolute path of the `.html` file. For a page with data files or images,
  put everything in one folder with an `index.html` and pass the folder.
- `files` adds individual files: `{ "data/sales.json": "/abs/path/sales.json" }`.
- `title` defaults to the page's `<title>`. `description` is one sentence for the list.
- A new page goes into the project named after the git repository you are working in, so the
  list stays sorted by itself. Pass `project` only when the page belongs somewhere else (the
  user names a project, or you work outside the repository it is about).
- Related pages can form a tree, like chapters under a handbook. Pass `parent` (the URL of the
  page to put it under) to publish a page as a child of another; it goes into that page's
  project. `move` changes the parent or the order later.
- `labels` group pages across projects: "decision" for a decision record, "draft" for unfinished
  work, or a word the user uses. Reuse the labels already in use (`list` shows them); `labels`
  adds and removes them later, and `search` with `label:<name>` finds a label's pages.
- Before you start on a project's pages, `activity` shows what people and agents changed lately.
- A Markdown page (an `.md` file) can hold macros, each on a line of its own: `{{toc}}` (its
  sections), `{{children}}` (the pages under it), `{{recent}}`, `{{label <name>}}` and
  `{{include <page url>}}` (a Markdown page of the same project, shown in place). Use them for
  hub pages instead of keeping lists of links by hand.
- Before writing a page about something, `search` for pages that cover it already and link to
  them with their URLs (`https://<host>/a/<id>`) instead of repeating them. Links between pages
  show up on both pages, and clicking one opens the other in the viewer.
- People comment on pages. When asked to act on them, read the threads with `comments`, change
  the page, then answer each thread with `comment` (`reply_to` its id) and `resolve: true` when
  you did what it asked. Do not resolve a thread you only replied to with a question.
- Give the user the URL from the result. Do not paste the page's content back into the chat.

## Update

Publishing the same `file_path` again updates the same URL (a new version; old versions stay
available). So for "change the colours", edit the file and publish it again.

To update a page that was published from another file or computer, pass its `url`. If the
result says another version is the latest, `read` that version, merge your change into it, and
publish again. Never overwrite someone else's newer version without merging. People also change
pages in the browser (Markdown pages, and the source of HTML pages), so a page you published may
have a newer version written by a person: read it before changing the page again.

## External data

A page can only `fetch` its own files. If it genuinely needs live data from another host, pass
`allow_connect: ["api.example.com"]` and tell the user, because the page will be marked as
having external access. Prefer saving the data into a file published with the page.

## Read, list, delete

- `read({ url, path? })` returns the published HTML (or another file). Use it before changing a
  page you did not write in this session.
- `list()` shows recent pages, newest first.
- `delete({ url })` moves a page to the trash (restorable for 30 days). Only when the user
  asked for that page to be deleted.

## Handing over a secret

Never put a password, key or token in a page. To give one to a person, use the secret tools.

Usually one step is enough: `secret_share({ label, file_path, keys? })` encrypts the values from
a local file and returns a link with its key after `#`. Give the whole link to the user to pass
on. The first browser that opens it and presses Show reads the values; afterwards
`secret_status({ id })` shows when and from where it was opened. If that was not the recipient,
tell the user, and make a new link once they ask you to delete the old one.

When the user wants to confirm the recipient before anything is sent:

1. `secret_request({ label })` returns a link; give it to the user to send to the recipient.
2. When `secret_status({ id })` says `claimed`, check that the open (time, IP, browser) looks
   like the intended person. If the user wants to be sure, they compare the 12-digit fingerprint
   with the recipient's page.
3. `secret_send({ id, file_path, keys? })` encrypts the values from a local file. Pass the file,
   never the values: do not write a secret into tool arguments or the conversation.
4. `secret_delete({ id })` only when the user asks.

## Using the vault

The vault keeps the user's API keys and passwords encrypted; only this computer's key (and the
owner's recovery key) can open them. Values never pass through you.

- `vault_list({ collection? })` shows collections, then the secrets of one: names, what each is,
  what uses it. Use `used_by` to find which secret a service needs.
- To store a value: `vault_put({ collection, name, file_path })` from a local file the user wrote,
  or `vault_put({ collection, name, generate: true })` for a new random value (then put it where
  it is needed with `vault_use`). Never pass the value itself, and never ask the user to paste it
  into the conversation: ask them to save it to a file and give you the path.
- To use a value: `vault_use({ collection, name, into: { command: ["gcloud", "secrets", "versions",
  "add", "resend-api-key", "--data-file=-"] } })` pipes it into `gcloud`, `gh`, `wrangler` or
  `circleci`; `into: { file_path }` writes a 0600 file for a tool that needs one (delete it after).
  The value is not returned to you; say what you did, not what it was.
- `vault_grant({ collection, device })` lets another computer read. Before calling it, have the
  user compare the fingerprint from `vault_devices()` with `artifact vault key` on that computer.
- `vault_destroy` only when the user asks. `artifact vault init`, `revoke`, `rotate` and `recover`
  are terminal commands for the user.
- If a tool says this computer cannot read a collection, tell the user: a computer that can must
  run `artifact vault grant <collection> <this device>`, or they use `artifact vault recover`
  with the recovery key.
- Delivery: `vault_target({ collection, name, add })` records where a value must go
  (`gcp://<project>/<secret id>`, `circleci://gh/<org>/<context>/<VAR>?token=<collection>/<name>`,
  `github://<owner>/<repo>/<NAME>`, `wrangler://<worker>/<NAME>`, `envfile:///path/.env#KEY`
  with `plaintext_ok`). `vault_status({ collection })` shows which targets are stale.
  `vault_push({ collection })` only shows the plan; call it with `apply: true` when the user asked
  to deliver, and report what arrived where, never the values. After a Secret Manager delivery,
  Cloud Run uses the new version from its next revision, so say that too.

## Errors

The error text says what to do. If it says the user must run `artifact login`, tell them to run
it in a terminal; you cannot log in for them.
