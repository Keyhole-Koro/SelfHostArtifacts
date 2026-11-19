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

MCP: `publish({ file_path, title?, description?, files?, url?, allow_connect? })`
CLI: `artifact publish <file.html|folder> [--title …] [--description …]`

- `file_path` is the absolute path of the `.html` file. For a page with data files or images,
  put everything in one folder with an `index.html` and pass the folder.
- `files` adds individual files: `{ "data/sales.json": "/abs/path/sales.json" }`.
- `title` defaults to the page's `<title>`. `description` is one sentence for the list.
- A new page goes into the project named after the git repository you are working in, so the
  list stays sorted by itself. Pass `project` only when the page belongs somewhere else (the
  user names a project, or you work outside the repository it is about).
- Give the user the URL from the result. Do not paste the page's content back into the chat.

## Update

Publishing the same `file_path` again updates the same URL (a new version; old versions stay
available). So for "change the colours", edit the file and publish it again.

To update a page that was published from another file or computer, pass its `url`. If the
result says another version is the latest, `read` that version, merge your change into it, and
publish again. Never overwrite someone else's newer version without merging.

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

## Errors

The error text says what to do. If it says the user must run `artifact login`, tell them to run
it in a terminal; you cannot log in for them.
