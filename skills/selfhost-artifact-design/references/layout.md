# Layout

## Spacing scale

Use only these gaps. Consistent spacing does more for a page's polish than any colour choice.

```css
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --radius: 10px; --radius-sm: 6px;
}
```

- Inside a component (label to value, icon to text): `--space-1` to `--space-3`.
- Between related items (cards in a grid, paragraphs): `--space-4` to `--space-5`.
- Between sections: `--space-7` (desktop) / `--space-6` (phone).

## Page frame

```css
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; }
main { max-width: 960px; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-8); }
main.wide { max-width: 1200px; }   /* dashboards with several columns */
img, svg, canvas, video { max-width: 100%; height: auto; }
```

- 16px side padding at every width; on wide screens the column is centred.
- Documents: 720–960px. Dashboards: up to 1200px. Never full-bleed text.

## Grids

```css
.grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.split { display: grid; gap: var(--space-6); grid-template-columns: minmax(0, 1fr); }
@media (min-width: 800px) { .split { grid-template-columns: minmax(240px, 1fr) minmax(0, 2fr); } }
```

`auto-fit` with `minmax` collapses to one column on a phone without extra media queries. Use
`minmax(0, 1fr)` for columns that hold tables or code, so they can shrink and scroll.

## Things that must scroll inside their own box

Tables, code blocks, wide diagrams and timelines:

```html
<div class="scroll-x"><table>…</table></div>
```
```css
.scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }
```

Test at 360px wide: the page itself never scrolls sideways. Long URLs and identifiers in text:
`overflow-wrap: anywhere`.

## Structure

- One `<h1>`. `<h2>` for sections, `<h3>` sparingly. Do not skip levels.
- Lead with the answer, key figures or the main control. Method, caveats and raw data go lower.
- Use `<details><summary>` for long supporting material most readers will skip.
- A page longer than about three screens gets a short table of contents at the top (links to
  section ids), not a sticky sidebar.
