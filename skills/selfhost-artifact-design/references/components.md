# Components

Copy what the page needs. Every piece uses the tokens from `theming.md`, `typography.md` and
`layout.md`, so it works in both modes and at every width.

## Stat tiles (dashboards)

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
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4) var(--space-5); }
.stat-label { font-size: var(--text-sm); color: var(--text-2); }
.stat-value { font-size: var(--text-2xl); font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; margin-top: var(--space-1); }
.stat-delta { font-size: var(--text-sm); margin-top: var(--space-1); color: var(--text-2); }
.stat-delta.up { color: var(--positive); }
.stat-delta.down { color: var(--negative); }
```

Two to four tiles. Each value has its unit and a comparison; a number without context means little.

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
.badge { display: inline-block; font-size: var(--text-xs); font-weight: 600; padding: 2px var(--space-2); border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
.badge.accent { background: var(--accent-soft); color: var(--accent); }
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

Draw simple diagrams as inline SVG: boxes, arrows and short labels, coloured with the tokens
(`fill="var(--surface)"`, `stroke="var(--border-strong)"`, arrows in `var(--accent)`). Set a
`viewBox`, `width="100%"`, a `min-width` that keeps the labels readable, and put it in `.scroll-x`
so it scrolls on a phone instead of shrinking to unreadable text. Give it `role="img"` and an
`aria-label` that says what it shows. Size boxes to their longest label plus `--space-3` padding.
