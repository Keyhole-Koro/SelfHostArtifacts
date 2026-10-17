# Charts

## Choose the chart from the question

| Question | Chart |
|---|---|
| How does it change over time? | Line (bars if there are fewer than ~8 periods) |
| How do categories compare? | Horizontal bars, sorted by value |
| What is the share of a whole? | One stacked bar or a table with percentages. A pie only for 2–3 parts |
| How are two measures related? | Scatter |
| How is one measure distributed? | Histogram |
| Exact values matter | A table, not a chart |

If the chart would have one or two data points, write the number in a stat tile instead.

## Every chart has

- A **title that states the finding** ("Kanto grew fastest in Q3"), in `--text-lg`, above the chart.
- Axis labels with units, ticks in `--text-xs` and `--text-2`, thousands separators.
- A y-axis that starts at zero for bars. Lines may zoom in, but say so if the change looks dramatic.
- Few gridlines, in `--border`, horizontal only.
- Direct labels on lines or bars when there are five series or fewer; otherwise a legend.
- A caption with the period and the source.
- A height that suits the data (240–360px) and a width that follows its container.

## Chart.js with the page's tokens

```html
<canvas id="signups" height="280" role="img" aria-label="Monthly sign-ups, January to September"></canvas>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = new Intl.NumberFormat();
let chart;
function draw() {
  chart?.destroy();
  chart = new Chart(document.getElementById('signups'), {
    type: 'line',
    data: { labels: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep'],
      datasets: [{ data: [120,135,150,148,190,260,300,320,355], borderColor: css('--series-1'),
        backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 0, tension: 0.25 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt.format(c.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: css('--text-2') }, border: { color: css('--border') } },
        y: { beginAtZero: true, grid: { color: css('--border') }, border: { display: false },
             ticks: { color: css('--text-2'), callback: (v) => fmt.format(v) } },
      },
    },
  });
}
draw();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
</script>
```

Wrap the canvas in a container with a fixed height (`.chart { position: relative; height: 280px; }`)
when `maintainAspectRatio` is false, so it does not grow forever.

## Plain SVG

For a handful of bars or a sparkline, inline SVG is lighter than a library and inherits the
tokens directly. Compute the coordinates in a few lines of script or by hand, use
`fill="var(--series-1)"`, and label values with `<text>` in `--text-sm`.
