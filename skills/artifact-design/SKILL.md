---
name: artifact-design
description: How to write an HTML page that will be published with the artifact tool (a report, dashboard, explainer, chart, comparison, notes or any page the user will open in a browser). Read before writing the page's HTML, CSS or scripts.
---

# Writing a page for `artifact`

The page is published privately and opened in a browser, on a desktop or a phone. It runs in a
sandbox with no origin, so some browser features are missing (see "Sandbox" below).

## Before you write

1. Decide what the reader needs first and put it at the top. A page is not a chat reply: no
   "Here is your page", no recap of the request.
2. Pick one layout: a document (headings and prose), a dashboard (a row of figures, then charts
   and tables), or a single tool (one interactive control area). Do not mix all three.
3. Write the page to a file. Use one self-contained `.html` file unless the page needs data files
   or images; then put them next to it and publish the folder (see the artifact-publish skill).

## Rules

- `<title>`: a short name of two to four words, e.g. `Q3 Sales`. Not a sentence, not "Report".
- Start with `<!doctype html>`, `<meta charset="utf-8">` and
  `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Colours are tokens on `:root`, redefined for dark mode. `body` sets its background and text
  colour explicitly. Details: `references/theming.md`.
- Works at phone width: 16px side padding, no horizontal page scroll, wide tables scroll inside
  their own container. Details: `references/layout.md`.
- Scripts and styles from other sites only from the allowed CDNs, with an exact version.
  Anything else is blocked. Details: `references/libraries.md`.
- Wrap every `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` access in
  `try/catch` and make the page work without them.
- No secrets, tokens, passwords, internal hostnames or personal data in the page or its files.
  The page is private, but it can be shared later.
- Say where numbers come from (a caption, a footnote or a "Sources" section) when they are not
  obvious from the page itself.

## Sandbox

The page runs in a sandboxed frame with an opaque origin:

- Storage APIs throw. Keep state in memory.
- `fetch` works for the page's own files (`fetch("data.json")`) and, only when the page was
  published with `allow_connect`, for those hosts. Everything else is blocked.
- Images, fonts and media load from the page's own files, `data:` URLs and the allowed CDNs only.
  Download an image you need and publish it with the page.
- `alert`, forms, downloads and links that open a new tab work. Service workers do not.

## Check before publishing

- Open the HTML in your head at 375px wide: does anything overflow?
- Dark mode: is any text a fixed colour on a token background, or the other way round?
- Every `<script src>` and stylesheet URL is on an allowed CDN with a pinned version.
