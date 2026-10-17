# Libraries

Pages may load scripts, styles and fonts from these hosts only. Requests to any other host are
blocked by the page's Content Security Policy.

| Host | Use for |
|---|---|
| `https://cdnjs.cloudflare.com` | Scripts and styles (preferred) |
| `https://cdn.jsdelivr.net/npm/` | npm packages |
| `https://unpkg.com` | npm packages |
| `https://fonts.googleapis.com`, `https://fonts.gstatic.com` | Google Fonts stylesheets and font files |

Always pin an exact version (`chart.js@4.4.1`, not `chart.js` or `chart.js@4`), so the page
keeps working when a library releases a breaking change. Use a version you know exists.

Good defaults:

- Charts: Chart.js (`https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`), or
  plain inline SVG for a few bars or lines.
- Maths: KaTeX (`https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/`).
- Diagrams: Mermaid (`https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js`).
- Syntax highlighting: highlight.js from cdnjs.

Prefer no library at all when a few lines of HTML, CSS or SVG do the job: the page loads faster
and has nothing to break.

Data for the page goes in its own files (`data.json`, `data.csv`) published with it, or inline
in a `<script type="application/json">` block. Fetching data from other hosts needs
`allow_connect` when publishing (see the selfhost-artifact-publish skill) and should be rare.
