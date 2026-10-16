# Theming

Define every colour once on `:root` and redefine the set for dark mode. Use the tokens
everywhere; never hard-code a colour in a component.

```css
:root {
  --bg: #fafaf9;
  --surface: #ffffff;
  --text: #1c1917;
  --muted: #57534e;
  --border: #e7e5e4;
  --accent: #2563eb;
  --positive: #15803d;
  --negative: #b91c1c;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09;
    --surface: #1c1917;
    --text: #f5f5f4;
    --muted: #a8a29e;
    --border: #292524;
    --accent: #60a5fa;
    --positive: #4ade80;
    --negative: #f87171;
    color-scheme: dark;
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

- Text on `--bg` and `--surface` must stay readable in both themes (aim for 4.5:1 contrast).
- Charts: read the tokens with `getComputedStyle(document.documentElement).getPropertyValue("--accent")`
  and redraw when `matchMedia("(prefers-color-scheme: dark)")` changes.
- Use at most one accent colour plus the positive/negative pair. For categorical series, use a
  small fixed palette that works on both backgrounds rather than generating colours.
- Images with transparent backgrounds need a `--surface` backdrop, or they vanish in dark mode.
