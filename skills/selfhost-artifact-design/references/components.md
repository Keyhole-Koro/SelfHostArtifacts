# Components

Copy what the page needs. Every piece uses the tokens from `theming.md`, `typography.md` and
`layout.md`, so it works in both modes and at every width.

Which component fits which content: SKILL.md, "Show, then tell".

| Component | For |
|---|---|
| Stat tiles | One number that matters, with its comparison |
| Key points | The 2–4 points to remember, often the first screen |
| Data bars | A few values to compare, without a chart library |
| Comparison cards | Options to choose between |
| Status list | Decisions, open questions, checks, tasks |
| Timeline | Events with dates |
| Steps | A straight procedure of up to five steps |
| Before / after | A change: how it was and how it is |
| 2×2 placement | Items rated on two axes |
| Tables | Exact values to look up |
| Details | Method, logs, raw data and history most readers skip |
| Callout, badge, icons | Marking one note, a status or a kind |

## Icons

Define the icons the page uses once, right after `<body>`, and reuse them with `<use>`. Line
icons in `currentColor` follow the text colour in both modes.

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></symbol>
  <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></symbol>
  <symbol id="i-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></symbol>
  <symbol id="i-chart" viewBox="0 0 24 24"><path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/></symbol>
</svg>
…
<svg class="icon"><use href="#i-check"/></svg>
```
```css
.icon { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.icon.sm { width: 16px; height: 16px; }
```

An icon marks a status (check, cross, warning) or a kind (person, file, server), at most one per
line. Colour it through its parent (`color: var(--positive)`), never inside the symbol. Draw a
new one in the same style (24×24, strokes only) when the set lacks it. No emoji.

## Stat tiles

```html
<div class="grid stats">
  <div class="stat">
    <div class="stat-label">Monthly revenue</div>
    <div class="stat-value">¥4.2M</div>
    <div class="stat-delta up">+12.4% vs. August</div>
  </div>
</div>
```
```css
.stats { grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr)); }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4) var(--space-5); }
.stat-label { font-size: var(--text-sm); color: var(--text-2); }
.stat-value { font-size: var(--text-2xl); font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; margin-top: var(--space-1); }
.stat-delta { font-size: var(--text-sm); margin-top: var(--space-1); color: var(--text-2); }
.stat-delta.up { color: var(--positive); }
.stat-delta.down { color: var(--negative); }
```

Two to four tiles. Each value has its unit and a comparison (last period, a target, a total); a
number without context means little. On a phone they sit two to a row.

## Key points

The 2–4 things the reader must remember, each a bold phrase and one line. A good first screen
after the lead.

```html
<ul class="points">
  <li><svg class="icon"><use href="#i-check"/></svg>
    <div><strong>Sign-ups doubled</strong><span>From 120 a week to 250 after the new form.</span></div></li>
  <li><svg class="icon"><use href="#i-alert"/></svg>
    <div><strong>Mobile still lags</strong><span>Half of the drop-offs are on the payment step.</span></div></li>
</ul>
```
```css
.points { list-style: none; margin: 0; padding: var(--space-4); display: grid; gap: var(--space-3) var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); background: var(--surface-2); border-radius: var(--radius); }
.points li { display: flex; gap: var(--space-3); align-items: flex-start; }
.points .icon { color: var(--accent); margin-top: 3px; }
.points strong { display: block; font-weight: 650; line-height: 1.5; }
.points span { display: block; font-size: var(--text-sm); line-height: 1.6; color: var(--text-2); }
```

## Data bars

Three to eight values compared at a glance, with no axis and no library. Set each width as the
value's share of the largest (or of the total, and say which in the caption).

```html
<ul class="bars" aria-label="Open issues by area">
  <li><span>Payments</span><span class="track"><span class="fill" style="width:100%"></span></span><span class="value">21</span></li>
  <li><span>Sign-in</span><span class="track"><span class="fill" style="width:43%"></span></span><span class="value">9</span></li>
</ul>
```
```css
.bars { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.bars li { display: grid; grid-template-columns: minmax(0, 12em) minmax(0, 1fr) 4.5em; gap: var(--space-3); align-items: center; font-size: var(--text-sm); }
.bars .track, .bars .fill { display: block; }
.bars .track { height: 12px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.bars .fill { height: 100%; background: var(--series-1); border-radius: 999px; }
.bars .value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
@media (max-width: 520px) { .bars li { grid-template-columns: minmax(0, 1fr) 4.5em; } .bars .track { grid-column: 1 / -1; grid-row: 2; } }
```

The inline `width` is data, not styling. Colour one
bar with `--accent` or a status colour only when the text is about that bar.

## Comparison cards

One card per option, with the same rows in the same order so they compare line by line. Mark
the recommendation; say why in the card, not in a paragraph after it.

```html
<div class="options">
  <div class="option pick">
    <div class="option-head"><strong>Managed database</strong><span class="badge accent">Recommended</span></div>
    <ul>
      <li class="pro"><svg class="icon sm"><use href="#i-check"/></svg>Backups and failover included</li>
      <li class="con"><svg class="icon sm"><use href="#i-x"/></svg>¥18,000 a month more</li>
    </ul>
  </div>
  <div class="option">…</div>
</div>
```
```css
.options { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
.option { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); }
.option.pick { border: 2px solid var(--accent); }
.option-head { display: flex; justify-content: space-between; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
.option-head strong { font-weight: 650; }
.option ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--text-sm); line-height: 1.6; }
.option li { display: flex; gap: var(--space-2); align-items: flex-start; }
.option li .icon { margin-top: 2px; }
.option .pro .icon { color: var(--positive); }
.option .con .icon { color: var(--negative); }
```

Two to four options. With more options or more than about five rows each, use a table with one
column per option instead.

## Status list

Decisions, open questions, review items or tasks: one row each, the status first, a short title,
and one line of note (an owner, a date, the reason).

```html
<ul class="status-list">
  <li><span class="badge positive">Decided</span><strong>Keep files for 7 days</strong>
    <span class="note">Agreed on 11-08. Applies to new shares.</span></li>
  <li><span class="badge warning">Open</span><strong>Price of the team plan</strong>
    <span class="note">Needs the cost estimate first.</span></li>
</ul>
```
```css
.status-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.status-list li { display: grid; grid-template-columns: 7em minmax(0, 1fr); gap: var(--space-1) var(--space-3); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); align-items: baseline; }
.status-list li:first-child { border-top: 0; }
.status-list strong { font-weight: 650; }
.status-list .note { grid-column: 2; font-size: var(--text-sm); color: var(--text-2); line-height: 1.6; }
.status-list .badge { justify-self: start; }
```

Group by status (open items first) or sort by what the reader acts on first. Put a count of each
status in the summary block. Longer reasoning per item goes in a `<details>` inside the row.

## Timeline

Events in date order: a history, a plan, an incident. One line each, with a note when needed.

```html
<ol class="timeline">
  <li><time>10-17</time><span class="what">Version 0.2.2 released</span><span class="note">The version users have now.</span></li>
  <li class="warn"><time>11-08</time><span class="what">Guide merged, not released</span></li>
  <li class="now"><time>11-13</time><span class="what">Pages measured</span></li>
</ol>
```
```css
.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; padding: 0 0 var(--space-4) var(--space-6); }
.timeline li::before { content: ""; position: absolute; left: 6px; top: 10px; bottom: -10px; width: 2px; background: var(--border); }
.timeline li:last-child::before { display: none; }
.timeline li::after { content: ""; position: absolute; left: 0; top: 6px; width: 14px; height: 14px; border-radius: 50%; background: var(--surface); border: 2px solid var(--border-strong); }
.timeline li.now::after { border-color: var(--accent); background: var(--accent); }
.timeline li.warn::after { border-color: var(--warning); }
.timeline time { font-size: var(--text-sm); font-weight: 650; font-variant-numeric: tabular-nums; margin-right: var(--space-2); }
.timeline .what { font-weight: 600; }
.timeline .note { display: block; font-size: var(--text-sm); color: var(--text-2); line-height: 1.6; }
```

A plan with start and end dates per task is a table (task, start, end, status). A timeline drawn
to scale is hand-drawn SVG (`diagrams.md`).

## Steps

A straight procedure of up to five steps, with no branches. Branches or loops need a flowchart
(`diagrams.md`).

```html
<ol class="steps">
  <li><strong>Fix the skill</strong>Branch from main and open a PR<span class="badge who">Agent</span></li>
  <li><strong>Release</strong>Bump the version and merge into publish<span class="badge who">You</span></li>
</ol>
```
```css
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); grid-template-columns: minmax(0, 1fr); counter-reset: step; }
@media (min-width: 860px) { .steps { grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); } }
.steps li { counter-increment: step; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); font-size: var(--text-sm); line-height: 1.6; }
.steps li::before { content: counter(step); display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: var(--text-xs); margin-bottom: var(--space-2); }
.steps strong { display: block; font-weight: 650; }
.steps .who { display: table; margin-top: var(--space-2); }
```

The steps sit in a row on a desktop and stack on a phone. Keep each to a title and one line;
commands go in a `<pre>` after the steps or in `<details>`.

## Before / after

A change shown as two sides: how it was and how it is (or the current rule and the proposal).
One block per change, so a list of changes reads as a list of pairs.

```html
<div class="ba">
  <div class="ba-head"><strong>Login</strong><span class="badge">auth.ts</span></div>
  <div class="ba-body">
    <div class="ba-side"><span class="label">Before</span>Two database calls on every login.</div>
    <svg class="icon ba-arrow"><use href="#i-arrow"/></svg>
    <div class="ba-side after"><span class="label">After</span>One call; the counter is cleared only after a failure.</div>
  </div>
</div>
```
```css
.ba { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); margin-bottom: var(--space-4); }
.ba-head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); }
.ba-head strong { font-weight: 650; }
.ba-body { display: grid; gap: var(--space-3); grid-template-columns: minmax(0, 1fr); }
@media (min-width: 720px) { .ba-body { grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr); align-items: start; } }
.ba-side { font-size: var(--text-sm); line-height: 1.7; }
.ba-side .label { display: block; font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.06em; color: var(--text-2); margin-bottom: var(--space-1); }
.ba-side.after { border-left: 3px solid var(--accent); padding-left: var(--space-3); }
.ba-side.after .label { color: var(--accent); }
.ba-arrow { color: var(--text-3); margin-top: 22px; }
@media (max-width: 719px) { .ba-arrow { display: none; } }
```

For a change in numbers, use stat tiles with the old value in the delta line, or a chart.

## 2×2 placement

Items placed by two judgements (impact and effort, urgency and importance). Name each quadrant
by what to do with it; the item names are chips.

```html
<figure class="figure">
  <div class="quad" role="img" aria-label="Six fixes placed by impact and effort">
    <div class="quad-cell key"><span class="quad-name">High impact · low effort — do first</span><span class="chip">Text budget</span><span class="chip">First screen</span></div>
    <div class="quad-cell"><span class="quad-name">High impact · high effort — plan</span><span class="chip">New components</span></div>
    <div class="quad-cell"><span class="quad-name">Low impact · low effort — when convenient</span><span class="chip">Icons</span></div>
    <div class="quad-cell"><span class="quad-name">Low impact · high effort — skip</span></div>
  </div>
  <figcaption>Fixes placed by expected effect on the pages and by the work they need.</figcaption>
</figure>
```
```css
.quad { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.quad-cell { background: var(--surface-2); border-radius: var(--radius-sm); padding: var(--space-3); min-height: 112px; }
.quad-cell.key { background: var(--accent-soft); }
.quad-name { display: block; font-size: var(--text-xs); font-weight: 600; color: var(--text-2); margin-bottom: var(--space-2); }
.chip { display: inline-block; font-size: var(--text-sm); line-height: 1.5; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 2px var(--space-3); margin: 0 var(--space-1) var(--space-1) 0; }
```

Placed by measured numbers on both axes, it is a scatter chart (`charts.md`).

## Tables

```html
<div class="scroll-x"><table class="data">
  <thead><tr><th>Region</th><th class="num">Revenue</th><th class="num">Change</th></tr></thead>
  <tbody><tr><td>Kanto</td><td class="num">¥1,840,000</td><td class="num up">+8.1%</td></tr></tbody>
</table></div>
```
```css
table.data { width: 100%; border-collapse: collapse; font-size: var(--text-sm); background: var(--surface); }
table.data th, table.data td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
table.data th { font-weight: 600; color: var(--text-2); background: var(--surface-2); position: sticky; top: 0; }
table.data .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.data tbody tr:hover { background: var(--surface-2); }
.scroll-x > table.data { min-width: 560px; } /* scroll on a phone instead of crushing the columns */
table.data .up { color: var(--positive); } table.data .down { color: var(--negative); }
```

Inside `.scroll-x`, give the table a `min-width` that keeps its longest labels on one or two lines;
on a phone the table then scrolls sideways instead of wrapping every cell. No vertical borders, no
zebra stripes. Wrap in a bordered, rounded container if it sits among cards.
More than about 20 rows: add a filter input above it (in-memory filtering, no storage).

A table is for looking values up. Options, statuses and changes read better as comparison cards,
a status list or before / after; a table whose cells hold sentences is usually one of those.

## Details

Supporting material most readers skip: method, commands, logs, raw data, full tables, history,
the reasoning behind each item. It keeps the visible page within the word budget.

```html
<details class="more">
  <summary>How this was measured</summary>
  <div class="more-body">…</div>
</details>
```
```css
details.more { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin: var(--space-4) 0; }
details.more > summary { cursor: pointer; padding: var(--space-3) var(--space-4); font-weight: 600; }
details.more[open] > summary { border-bottom: 1px solid var(--border); }
details.more > .more-body { padding: var(--space-4); }
```

The summary says what is inside ("Commands used", "All 42 rows"), not "More". Nothing the
reader needs for the main finding goes in here.

## Callout

```html
<div class="callout"><strong>Note</strong> Prices exclude tax.</div>
```
```css
.callout { background: var(--accent-soft); border-radius: var(--radius); padding: var(--space-3) var(--space-4); }
.callout strong { color: var(--accent); margin-right: var(--space-2); }
.callout.warning { background: color-mix(in srgb, var(--warning) 14%, var(--surface)); }
.callout.warning strong { color: var(--warning); }
```

At most one or two per page; a page full of callouts has none.

## Badge

```css
.badge { display: inline-block; font-size: var(--text-xs); font-weight: 600; line-height: 1.5; padding: 2px var(--space-2); border-radius: 999px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }
.badge.accent { background: var(--accent-soft); color: var(--accent); }
.badge.positive { background: color-mix(in srgb, var(--positive) 14%, var(--surface)); color: var(--positive); }
.badge.warning { background: color-mix(in srgb, var(--warning) 14%, var(--surface)); color: var(--warning); }
.badge.negative { background: color-mix(in srgb, var(--negative) 14%, var(--surface)); color: var(--negative); }
```

## Buttons and inputs (tools)

```css
button, .button { font: inherit; font-size: var(--text-sm); font-weight: 600; padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input, select, textarea { font: inherit; font-size: var(--text-md); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); width: 100%; }
label { display: block; font-size: var(--text-sm); font-weight: 500; color: var(--text-2); margin-bottom: var(--space-1); }
```

Inputs use `--text-md` (16px) so phones do not zoom in on focus. One primary button per view.

## Tabs (in-memory, no storage)

```html
<div class="tabs" role="tablist">
  <button role="tab" aria-selected="true" data-panel="p1">Overview</button>
  <button role="tab" aria-selected="false" data-panel="p2">Details</button>
</div>
<section id="p1">…</section><section id="p2" hidden>…</section>
<script>
document.querySelectorAll('[role=tab]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((t) => {
    t.setAttribute('aria-selected', String(t === tab));
    document.getElementById(t.dataset.panel).hidden = t !== tab;
  });
}));
</script>
```
```css
.tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--border); margin-bottom: var(--space-5); overflow-x: auto; }
.tabs [role=tab] { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--text-2); padding: var(--space-2) var(--space-3); }
.tabs [role=tab][aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }
```

## Figure with caption

```html
<figure class="figure"><div class="scroll-x">…chart or diagram…</div>
  <figcaption>Monthly sign-ups, Jan–Sep 2026. Source: product database.</figcaption></figure>
```
```css
.figure { margin: var(--space-5) 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); }
.figure figcaption { font-size: var(--text-sm); color: var(--text-2); margin-top: var(--space-3); }
```

## Diagrams

Flowcharts, sequence, state and block diagrams: Mermaid, with the recipe and syntax rules in
`diagrams.md`. Other shapes: hand-drawn inline SVG, also in `diagrams.md`.
