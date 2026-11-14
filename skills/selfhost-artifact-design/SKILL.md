---
name: selfhost-artifact-design
description: How to design and write an HTML page that will be published with the self-hosted `artifact` tool (a report, dashboard, explainer, chart, comparison, notes or any page the user will open in a browser). Read before writing the page's HTML, CSS or scripts.
---

# Designing a page for `artifact`

The page is published privately and opened in a browser on a desktop or a phone, in light or dark
mode. It runs in a sandbox with no origin (see "Sandbox"). Aim for a page that looks deliberate
(calm, legible, consistent) and that the reader understands by looking before reading: one clear
message at the top, the content shown as figures and components, and only the prose that
connects them.

## Workflow

1. **Decide the message.** Write down, for yourself, the one sentence the reader should take away.
   It becomes the `<h1>` or the lead. A page is not a chat reply: no "Here is your page", no
   recap of the request, no closing summary of what you did.
2. **Pick one shape** (see "Shapes"). Do not mix them.
3. **Plan the first screen.** Choose the one visual block that carries the message (see "First
   screen").
4. **Pick a visual for each part.** Go through the content with "Show, then tell" and note the
   figure or component for every section, before writing any prose.
5. **Start from `references/starter.html`.** Copy it, keep its tokens and base styles, and add
   only what this page needs from `references/components.md`.
6. **Fill it with the real content.** Real numbers, real names, real units. No lorem ipsum, no
   placeholder charts, no "TODO".
7. **Cut the words** to "Keep the words few". Move method, logs and history into `<details>`.
8. **Check it** with the list at the end, then publish (see the selfhost-artifact-publish skill).

## Shapes

| Shape | Use for | Structure |
|---|---|---|
| **Document** | Explanations, reports, notes, work logs | `<h1>`, a lead, a summary block (the first screen), then `<h2>` sections that each lead with a figure or component and add short prose; supporting material in `<details>` |
| **Decision** | Options to choose between, decisions made or still open, review lists | `<h1>` names the question; the summary block gives the recommendation or the count of open items; comparison cards for options; a status list for decisions and open items; the reasoning in short prose or `<details>` |
| **Dashboard** | Numbers to monitor or compare | A row of 2–4 stat tiles, then 1–3 charts; the detailed table in `<details>` when it repeats the charts |
| **Tool** | Something to interact with (a calculator, a filterable list) | Controls on top or on the left, the result next to them, an explanation below |

## First screen

The first screen (the top 800px on a desktop) holds the `<h1>`, a lead of at most two
sentences, and one visual block that carries the main finding: stat tiles, key points,
comparison cards, a status list or a figure. Not a paragraph, and not a table. A reader who
stops here knows the answer.

## Show, then tell

Readers take in a sequence, a structure, a comparison or a set of statuses faster from a picture
or a layout than from paragraphs. Give every part of the content its visual form first; then
write only the prose the visual cannot say: why, and what follows.

| The content has… | Show it as | How |
|---|---|---|
| A procedure or decision with 3 or more steps | Flowchart; steps for a straight line of up to 5 | `diagrams.md`, `components.md` |
| Requests passing between 3 or more systems or people | Sequence diagram | `diagrams.md` |
| Something that changes state (an order, a contract, a ticket) | State diagram | `diagrams.md` |
| Parts and how they connect (architecture, data flow, who owns what) | Block diagram | `diagrams.md` |
| Numbers over time or across categories | Chart; data bars for a few values | `charts.md`, `components.md` |
| Options to choose between | Comparison cards, the recommendation marked | `components.md` |
| Items with a status (decisions, open questions, checks, tasks) | Status list | `components.md` |
| Events with dates (a history, a plan) | Timeline | `components.md` |
| A change: how it was and how it is | Before / after | `components.md` |
| Items rated on two axes (impact and effort) | 2×2 placement | `components.md` |
| The 2–4 points to remember | Key points | `components.md` |
| One number that matters | Stat tile | `components.md` |
| Exact values to look up | Table | `components.md` |

Each figure sits next to the prose it explains and has a caption that says what it shows.

A list of independent items is not a diagram, but it is not prose either: give it cards, a
status list or a table. A paragraph per item is the shape to avoid.

## Keep the words few

- **Lead:** at most two sentences.
- **Paragraph:** at most three sentences (in Japanese, about 120 characters).
- **At most two paragraphs in a row.** Then a visual block, a list or the next section.
- **About 3,000 characters of Japanese, or 1,000 words of English, visible on the page.**
  Method, commands, logs, raw data, full tables and history go in `<details>` (see
  `components.md`). A reference document that has to be long gets a table of contents and keeps
  every section within the limits above.
- Labels in components stay short: a card title is a few words, a status note one line.
- Do not restate the heading, narrate how you got there, or repeat a caveat in every section.

To count the visible text (everything outside `<details>`, scripts, styles, SVG and Mermaid
source):

```sh
python3 -c "import re,sys;h=open(sys.argv[1],encoding='utf-8').read();h=re.sub(r'(?s)<(details|script|style|svg)\b.*?</\1>|<div[^>]*\bmermaid\b[^>]*>.*?</div>','',h);t=re.sub(r'<[^>]+>',' ',h);print(len(re.sub(r'\s+','',t)),'characters,',len(t.split()),'words')" page.html
```

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
  mark. Everything else is neutral. Status colours (positive, negative, warning) only for
  status: on badges, icons, and the edge of a card or a bar.
- **Hierarchy by size and weight; groups by surfaces.** A clear `<h1>`, quieter `<h2>`, body
  text and muted secondary text set the order. A card for each option, step or item that stands
  on its own, and `--surface-2` behind the summary block, set the groups.
- **Whitespace is structure.** Separate sections with space (and at most a hairline border), not
  with heavy boxes, shadows or background stripes.
- **Few borders, soft corners, almost no shadows.** 1px borders in `--border`, radius 6–10px.
- **Numbers are aligned.** `font-variant-numeric: tabular-nums`, right-aligned in tables, with
  units and thousands separators (`Intl.NumberFormat`).
- **Charts state the finding.** The chart title is the takeaway ("Sign-ups doubled after the
  redesign"), not the metric name. See `references/charts.md`.
- **Icons mark a status or a kind.** The inline SVG set in `references/components.md`, in
  `currentColor`, at most one per line. No emoji as icons.
- **No decoration for its own sake**: no gradients on text, no animation that does not explain
  something, no hero images. A diagram that shows how something works is content, not decoration.

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

- [ ] The first screen holds the `<h1>`, a lead of at most two sentences and a visual block that
      carries the main finding, not a paragraph or a table.
- [ ] Every part of the content has its visual form from "Show, then tell"; every figure has a
      caption.
- [ ] No more than two paragraphs in a row, none over three sentences, and the visible text
      within the budget (count it); the rest is in `<details>`.
- [ ] No chart is followed by a table of the same numbers outside `<details>`.
- [ ] Every Mermaid diagram follows the syntax rules in `references/diagrams.md`.
- [ ] At 360px: nothing overflows the page; tables and diagrams scroll inside their box.
- [ ] Dark mode: no fixed colour anywhere (search the file for `#` and `rgb` outside `:root`).
- [ ] Every text size and gap comes from the scales.
- [ ] Every chart has a takeaway title, labelled axes with units, and a source.
- [ ] Every `<script src>` and stylesheet is on an allowed host with a pinned version.
- [ ] No chat-style filler ("Here is…", "I hope this helps").
