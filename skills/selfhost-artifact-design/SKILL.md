---
name: selfhost-artifact-design
description: How to design and write an HTML page that will be published with the self-hosted `artifact` tool (a report, dashboard, explainer, chart, comparison, notes or any page the user will open in a browser). Read before writing the page's HTML, CSS or scripts.
---

# Designing a page for `artifact`

The page is published privately and opened in a browser on a desktop or a phone, in light or dark
mode. It runs in a sandbox with no origin (see "Sandbox"). Aim for a page that looks deliberate:
calm, legible, consistent, with one clear message at the top.

## Workflow

1. **Decide the message.** Write down, for yourself, the one sentence the reader should take away.
   It becomes the `<h1>` or the lead paragraph. A page is not a chat reply: no "Here is your
   page", no recap of the request, no closing summary of what you did.
2. **Pick one shape** (see "Shapes"). Do not mix them.
3. **Start from `references/starter.html`.** Copy it, keep its tokens and base styles, and add
   only what this page needs from `references/components.md`.
4. **Fill it with the real content.** Real numbers, real names, real units. No lorem ipsum, no
   placeholder charts, no "TODO".
5. **Check it** with the list at the end, then publish (see the selfhost-artifact-publish skill).

## Shapes

| Shape | Use for | Structure |
|---|---|---|
| **Document** | Explanations, reports, notes, decisions | `<h1>`, a lead paragraph, `<h2>` sections of prose, tables and figures where they help |
| **Dashboard** | Numbers to monitor or compare | A row of 2–4 stat tiles, then 1–3 charts, then the detailed table |
| **Tool** | Something to interact with (a calculator, a filterable list) | Controls on top or on the left, the result next to them, an explanation below |

## Non-negotiables

- `<!doctype html>`, `<html lang="…">` in the content's language, `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- `<title>`: a name of two to four words (`Q3 Sales`, `Setup Explained`). Never a sentence.
- Every colour comes from a token on `:root`, and the tokens are redefined for dark mode.
  `body` sets `background` and `color` from tokens. See `references/theming.md`.
- Text sizes and spacing come from the scales in `references/typography.md` and
  `references/layout.md`. No one-off values like `font-size: 15.5px` or `margin: 13px`.
- Works at 360px wide: 16px side padding, no sideways page scroll. Wide tables, code and
  diagrams scroll inside their own box.
- External scripts, styles and fonts only from the hosts in `references/libraries.md`, with an
  exact version. Everything else is blocked.
- No secrets, tokens, passwords, internal hostnames or personal data in the page or its files.
- Numbers say where they come from (caption, footnote or a Sources section) unless obvious.

## Taste

- **One accent colour.** Use it for links, the primary action and the single most important
  mark. Everything else is neutral. Status colours (positive, negative, warning) only for status.
- **Hierarchy by size and weight, not by colour or boxes.** A clear `<h1>`, quieter `<h2>`, body
  text, and muted secondary text cover almost everything.
- **Whitespace is structure.** Separate sections with space (and at most a hairline border),
  not with heavy boxes, shadows or background stripes. Cards only for things that are
  genuinely separate items (stat tiles, list items).
- **Few borders, soft corners, almost no shadows.** 1px borders in `--border`, radius 6–10px.
- **Numbers are aligned.** `font-variant-numeric: tabular-nums`, right-aligned in tables, with
  units and thousands separators (`Intl.NumberFormat`).
- **Charts state the finding.** The chart title is the takeaway ("Sign-ups doubled after the
  redesign"), not the metric name. See `references/charts.md`.
- **No decoration for its own sake**: no gradients on text, no emoji as icons, no animation that
  does not explain something, no hero images.

## Sandbox

The page runs in a sandboxed frame with an opaque origin:

- `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` throw. Keep state in memory
  (wrap any access in `try/catch` if a library touches them).
- `fetch` works for the page's own files (`fetch("data.json")`) and, only when the page was
  published with `allow_connect`, for those hosts.
- Images, fonts and media load from the page's own files, `data:` URLs and the allowed CDNs.
  Download any image you need and publish it with the page.
- `alert`, forms, downloads and links that open a new tab work. Service workers do not.

## Check before publishing

- [ ] The first screen says what the page is about and the main finding.
- [ ] At 360px: nothing overflows the page; tables and diagrams scroll inside their box.
- [ ] Dark mode: no fixed colour anywhere (search the file for `#` and `rgb` outside `:root`).
- [ ] Every text size and gap comes from the scales.
- [ ] Every chart has a takeaway title, labelled axes with units, and a source.
- [ ] Every `<script src>` and stylesheet is on an allowed host with a pinned version.
- [ ] No chat-style filler ("Here is…", "I hope this helps").
