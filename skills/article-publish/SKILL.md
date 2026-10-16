---
name: article-publish
description: When and how to publish, update, read or delete pages with the article MCP tools (publish, read, list, delete) or the `article` CLI. Use when the user wants something as a web page, link or shareable page, or asks to change a page published earlier.
---

# Publishing with `article`

`article` publishes a local HTML page to the user's own private site and returns a URL such as
`https://article.example.com/a/x7k2m9q4p1r8t3v6`. Only the owner and the viewers they added
can open it.

## When to publish

- The user asks for a page, report, dashboard, chart or anything "to open in the browser".
- The result is clearer as a page than as terminal text (a table that is too wide, a chart, a
  long document they will come back to), and the user would want the link. Say in one line that
  you can publish it if they did not ask.
- Not for content the user marked as sensitive, and never for secrets or credentials.

Read the article-design skill before writing the page.

## Publish

MCP: `publish({ file_path, title?, description?, files?, url?, allow_connect? })`
CLI: `article publish <file.html|folder> [--title …] [--description …]`

- `file_path` is the absolute path of the `.html` file. For a page with data files or images,
  put everything in one folder with an `index.html` and pass the folder.
- `files` adds individual files: `{ "data/sales.json": "/abs/path/sales.json" }`.
- `title` defaults to the page's `<title>`. `description` is one sentence for the list.
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

## Errors

The error text says what to do. If it says the user must run `article login`, tell them to run
it in a terminal; you cannot log in for them.
