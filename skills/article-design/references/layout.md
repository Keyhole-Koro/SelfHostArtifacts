# Layout

## Width

```css
*, *::before, *::after { box-sizing: border-box; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
img, svg, canvas, video { max-width: 100%; height: auto; }
```

- 16px side padding at every width. Wider screens get a centred column, not edge-to-edge text.
- Prose lines stay under about 75 characters (`max-width: 70ch` on text blocks).
- Nothing may make the page scroll sideways at 360px. Long words and URLs: `overflow-wrap: anywhere`.

## Tables

Wrap wide tables so only the table scrolls:

```html
<div style="overflow-x:auto"><table>…</table></div>
```

Right-align numbers, use `font-variant-numeric: tabular-nums`, and keep a header row.

## Grids of cards and figures

```css
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
```

`auto-fit` + `minmax` collapses to one column on phones without media queries.

## Headings and structure

- One `<h1>` (the page's subject), then `<h2>` sections. Do not skip levels.
- Lead with the answer or the key figures; put method, caveats and raw data lower down.
- Use `<details>` for long supporting material the reader may not need.

## Charts

- Give every chart a title that states the finding ("Sales doubled after March"), axis labels
  with units, and a short caption with the source.
- Keep charts responsive: size them from their container, and redraw on `resize`.
- Prefer a simple, readable chart (bar, line) over a dense one. Label values directly when
  there are only a few.
