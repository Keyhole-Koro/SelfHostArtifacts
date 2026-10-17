# Theming

All colours are tokens on `:root`, defined once for light mode and once for dark mode. Components
use only the tokens. This is what makes a page look consistent and keeps dark mode working.

## Tokens

```css
:root {
  color-scheme: light;
  /* Surfaces, from the page background up */
  --bg: #f8f8f7;          /* page */
  --surface: #ffffff;     /* cards, tables, code blocks */
  --surface-2: #f1f1ef;   /* hover, table header, inline code */
  /* Text */
  --text: #1a1a19;        /* body and headings */
  --text-2: #5f5e5a;      /* secondary: captions, labels, meta */
  --text-3: #8b8a85;      /* tertiary: placeholders, disabled */
  /* Lines */
  --border: #e4e3df;
  --border-strong: #cfcdc7;
  /* One accent */
  --accent: #2f5bd3;
  --accent-text: #ffffff; /* text on --accent */
  --accent-soft: #e8eefc; /* tinted backgrounds: selected row, callout */
  /* Status, only for status */
  --positive: #1d7a46;
  --negative: #c0362c;
  --warning: #8f5407;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #141413;
    --surface: #1c1c1b;
    --surface-2: #262624;
    --text: #ecebe8;
    --text-2: #a9a8a2;
    --text-3: #75746f;
    --border: #2f2f2c;
    --border-strong: #42413d;
    --accent: #7c9dff;
    --accent-text: #0e1220;
    --accent-soft: #1d2540;
    --positive: #4cc27e;
    --negative: #f0756a;
    --warning: #e3a447;
  }
}

body { background: var(--bg); color: var(--text); }
```

You may change the accent hue to suit the content (keep a light and a dark variant with readable
contrast), and you may warm or cool the neutrals slightly. Do not add more accents.

## Rules

- Never write a colour outside `:root`. If you need a new one, add a token and define it in both
  modes.
- `--text`, `--text-2`, `--accent` and the status colours reach at least 4.5:1 on `--bg`,
  `--surface` and `--surface-2` in both modes; recheck if you change them. `--text-3` (about
  3:1) is only for placeholders and disabled controls, never for text someone needs to read.
- Dark mode is not inverted light mode: surfaces get *lighter* as they rise (`--bg` darkest,
  `--surface-2` lightest), and the accent and status colours are brighter and less saturated.
- Images and SVGs with transparent backgrounds need a `--surface` behind them, or they vanish on
  dark. Inline SVGs use `currentColor` or `var(--…)` for strokes and fills.
- Elevation: prefer a 1px `--border` to a shadow. If something must float (a popover), use
  `box-shadow: 0 4px 16px rgb(0 0 0 / 0.12)` and nothing heavier.

## Chart colours

Use these in order for categorical series. They are distinguishable from each other and readable
on both backgrounds. Define them as tokens so charts can read them.

```css
:root {
  --series-1: #2f5bd3; --series-2: #d9822b; --series-3: #2a9d8f;
  --series-4: #b5487a; --series-5: #7a6fd0; --series-6: #8a8a85;
}
@media (prefers-color-scheme: dark) {
  :root {
    --series-1: #7c9dff; --series-2: #f0a35e; --series-3: #4fc3b4;
    --series-4: #e07aa8; --series-5: #a99cff; --series-6: #a9a8a2;
  }
}
```

- One series: use `--series-1` only. Emphasis on one bar among many: that bar `--series-1`, the
  rest `--border-strong`.
- More than six categories: group the smallest into "Other", or use a table instead.
- Sequential data (a heat map): one hue from `--accent-soft` to `--accent`. Diverging data:
  `--negative` through `--surface-2` to `--positive`.
- Never rely on colour alone: label lines directly or add a legend with the values.
