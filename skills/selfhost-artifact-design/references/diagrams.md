# Diagrams

A diagram shows what prose struggles with: order, branching, who talks to whom, how parts
connect, how a thing changes state. Draw these with Mermaid: you write text, it does the layout,
and the recipe below colours it from the page's tokens in light and dark mode. Draw inline SVG
by hand only for shapes Mermaid has no type for (see "Hand-drawn SVG").

## Pick the type

| The content describes… | Mermaid | Notes |
|---|---|---|
| Steps, a procedure, a decision | `flowchart TD` | Top-down fits a phone |
| Requests between systems or people, in order | `sequenceDiagram` | Wide; scrolls on a phone |
| Something moving between states (an order, a subscription, a ticket) | `stateDiagram-v2` | |
| Parts and how they connect (architecture, data flow) | `flowchart LR` with a `subgraph` per boundary (a cloud, a region, a team) | Use `id[("Name")]` for a database |
| Tables and their relations | `erDiagram` | |

A plan with dates is a table (task, start, end, status), not a Gantt chart: Mermaid's Gantt is
hard to read on a phone.

Keep one idea per diagram and about 12 nodes at most. Split a bigger one into an overview and
details. Keep labels short (about 20 characters); put the explanation in the prose and the
caption.

## Recipe

Each diagram sits in a figure with a caption, inside `.scroll-x` (see `components.md`). Write the
Mermaid source flush left inside `<div class="mermaid">`.

```html
<figure class="figure">
  <div class="scroll-x">
    <div class="mermaid" role="img" aria-label="An order request passes from the browser through Hosting and Cloud Run to Firestore">
sequenceDiagram
  participant browser as Browser
  participant hosting as Firebase Hosting
  participant api as Cloud Run (Hono)
  participant db as Firestore
  browser->>hosting: POST /api/orders
  hosting->>api: Forward with X-Forwarded-For
  api->>db: Write in a transaction
  db-->>api: OK
  api-->>browser: 201 Created
    </div>
  </div>
  <figcaption>How an order is saved. Source: server/routes/orders.ts.</figcaption>
</figure>
```

```css
.mermaid svg { display: block; margin: 0 auto; height: auto; }
.mermaid .key :is(rect, polygon, circle, path) { stroke: var(--accent) !important; stroke-width: 2px !important; }
.mermaid.is-error { white-space: pre; font: var(--text-sm)/1.6 var(--font-mono); color: var(--negative); }
.mermaid.is-error::before { content: "Diagram syntax error. Source:\A\A"; }
```

Once per page, at the end of `<body>`:

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dark = matchMedia('(prefers-color-scheme: dark)');
const diagrams = [...document.querySelectorAll('.mermaid')];
const sources = diagrams.map((el) => el.textContent);
async function drawDiagrams() {
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base', darkMode: dark.matches,
    fontFamily: css('--font-sans'), fontSize: 14,
    themeVariables: {
      background: css('--surface'), mainBkg: css('--surface-2'),
      primaryColor: css('--surface-2'), primaryTextColor: css('--text'), primaryBorderColor: css('--border-strong'),
      secondaryColor: css('--accent-soft'), tertiaryColor: css('--surface'),
      lineColor: css('--text-2'), textColor: css('--text'),
      actorBkg: css('--surface-2'), actorBorder: css('--border-strong'), actorTextColor: css('--text'),
      signalColor: css('--text-2'), signalTextColor: css('--text'),
      labelBackground: css('--surface'), edgeLabelBackground: css('--surface'),
      clusterBkg: css('--surface'), clusterBorder: css('--border-strong'),
      attributeBackgroundColorOdd: css('--surface'), attributeBackgroundColorEven: css('--surface-2'),
    },
  });
  const valid = [];
  for (const [i, el] of diagrams.entries()) {
    el.removeAttribute('data-processed');
    el.textContent = sources[i].trim();
    const ok = await mermaid.parse(sources[i], { suppressErrors: true });
    el.classList.toggle('is-error', !ok); // a broken diagram shows its source instead
    if (ok) valid.push(el);
  }
  await mermaid.run({ nodes: valid });
  // Shrink to the column, but never below 80% of natural size: past that, scroll instead.
  for (const svg of document.querySelectorAll('.mermaid svg')) {
    svg.style.minWidth = `${Math.round(svg.viewBox.baseVal.width * 0.8)}px`;
  }
}
drawDiagrams();
dark.addEventListener('change', drawDiagrams);
</script>
```

This works in the page's sandbox (Mermaid does not need storage), redraws when the colour scheme
changes, and keeps text readable on a phone by scrolling wide diagrams inside their box.

## Syntax rules

You cannot see the page, and one mistake turns a diagram into a red "Diagram syntax error" box.
Each rule below is a mistake that breaks parsing:

- **IDs are ASCII; text goes in a label.** `api["Cloud Run (Hono)"]`, `state "有料" as paid`,
  `participant api as Cloud Run (Hono)`. A non-ASCII ID breaks `class` in a state diagram;
  keeping every ID ASCII makes the rule simple.
- **Quote every flowchart label**: `api["Cloud Run (Hono)"]`, not `api(Cloud Run (Hono))`.
  Brackets, parentheses and colons inside an unquoted label end it early.
- **`end` is reserved** in flowcharts: never use it as an ID (`done` works).
- **No `;` in a sequence message**: it ends the statement. **No second `:` in a state
  transition label** (`a --> b: 10:00 run` breaks; write `a --> b: run at 10 am`).
- **The source is HTML text.** `<br>` becomes an HTML tag and vanishes before Mermaid sees it,
  and a bare `<` or `&` can do the same; write `&lt;` and `&amp;`. For a line break inside a
  label, use a Markdown string with a real newline:
  ``done["`Booking complete
  Email sent`"]``
- **No colours in the source.** No `style`, no colours in `classDef`, no `%%{init}%%` themes:
  the script takes colours from the tokens, so they follow dark mode. (`classDef` cannot even
  parse `var(--accent)`.)

## Highlight one node

To point at the node the text is about, give it the `key` class; the CSS above draws it in the
accent colour. One per diagram, like the accent everywhere else.

```
  classDef key stroke-width:2px
  class api key
```

State diagrams need the `classDef` line; flowcharts work with or without it, so always write it.

## Hand-drawn SVG

For shapes Mermaid has no type for (a screen layout sketch, a timeline drawn to scale, a 2×2
matrix, stacked layers), draw inline SVG: boxes, arrows and short labels, coloured with the
tokens (`fill="var(--surface)"`, `stroke="var(--border-strong)"`, arrows in `var(--accent)`). Set
a `viewBox`, `width="100%"`, a `min-width` that keeps the labels readable, and put it in
`.scroll-x` so it scrolls on a phone instead of shrinking to unreadable text. Give it
`role="img"` and an `aria-label` that says what it shows. Size boxes to their longest label plus
`--space-3` padding.
