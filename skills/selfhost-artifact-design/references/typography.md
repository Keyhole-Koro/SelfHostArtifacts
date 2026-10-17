# Typography

## Font stack

System fonts load instantly and look native on every platform. Include Japanese and other CJK
faces when the content uses them.

```css
:root {
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP",
    "Noto Sans CJK JP", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono", monospace;
}
```

A web font is rarely worth it. If the page is a showcase where typography is the point, load one
family from Google Fonts with `display=swap` and at most two weights.

## Scale

Use only these sizes. Each step is clearly different from the next, so hierarchy reads at a glance.

| Token | Size / line height | Use |
|---|---|---|
| `--text-xs` | 12px / 1.5 | Fine print, chart tick labels |
| `--text-sm` | 14px / 1.55 | Captions, table cells, meta, labels |
| `--text-md` | 16px / 1.7 | Body text (Japanese prose: 1.8) |
| `--text-lg` | 20px / 1.45 | `<h2>`, card titles |
| `--text-xl` | 24px / 1.35 | Lead paragraph on dashboards, `<h2>` in long documents |
| `--text-2xl` | 32px / 1.25 | `<h1>`, the big number in a stat tile |

```css
:root {
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-md: 1rem;
  --text-lg: 1.25rem; --text-xl: 1.5rem; --text-2xl: 2rem;
}
@media (max-width: 640px) {
  :root { --text-xl: 1.375rem; --text-2xl: 1.625rem; }
}
```

## Weights and colour

- Body 400, emphasis and labels 500–600, headings 650–700. Do not use 300 or 800+.
- Secondary text uses `--text-2`, not a smaller weight or opacity.
- Links: `--accent`, underlined on hover only inside navigation; underlined always inside prose.

## Rules

- Prose width at most `70ch` (Japanese: `40em`). Long lines are the most common cause of a page
  feeling tiring.
- Headings: tight letter spacing for large sizes (`letter-spacing: -0.01em` from `--text-xl` up).
  No all-caps headings; small all-caps labels (`--text-xs`, `letter-spacing: 0.06em`) are fine.
- Numbers: `font-variant-numeric: tabular-nums` wherever numbers are compared (tables, tiles,
  axes). Format with `Intl.NumberFormat` (`1,234,567`, `12.4%`, `¥1,200`).
- Code: `--font-mono` at `--text-sm`, in `--surface-2`. Do not put prose in code style.
- Paragraph spacing: `margin: 0 0 1em`. Headings get more space above than below (the heading
  belongs to the text after it).
