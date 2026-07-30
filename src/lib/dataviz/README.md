# dataviz

Charts, sparklines and KPI tiles that read their colours out of the running design system, so a
screenshot of the dashboard looks like the same product as the rest of the app — in light and dark.

```bash
cp -r $BASE/kit/dataviz src/lib/dataviz
npm i recharts        # then restart `npm run dev` — Vite does not pick up a new package while running
```

`Stat` and `Sparkline` have no dependency at all and paint on the first frame; only the four charts
pull recharts, and they do it with `await import(...)` so it never blocks first paint.

## Use it

```tsx
import { LineChart, Stat, StatGroup } from '@/lib/dataviz';

const rows = [
  { day: 'Mon', runs: 42 },
  { day: 'Tue', runs: 61 },
  { day: 'Wed', runs: 55 },
];

export function Dashboard() {
  return (
    <div className="flex flex-col gap-4">
      <StatGroup>
        <Stat label="Runs" value={158} delta={12.4} deltaSuffix="%" deltaLabel="vs last week" trend={rows.map((r) => r.runs)} />
      </StatGroup>
      <LineChart title="Runs per day" data={rows} x="day" series={[{ key: 'runs', label: 'Runs' }]} />
    </div>
  );
}
```

`BarChart` and `AreaChart` take the same props (`stacked` for parts of a whole); `PieChart` takes
`nameKey` / `valueKey` / `donut`. Every chart brings its own card, legend, empty state and error
state — there is nothing to wrap it in. Call `preloadCharts()` while the data is still being
fetched and the chart appears the instant it arrives.

| File | What it is |
|---|---|
| `Chart.tsx` | `LineChart` / `BarChart` / `AreaChart` / `PieChart` — theme applied, states rendered, phone axes |
| `ChartFrame.tsx` | the card, the legend, and the panel for idle / loading / empty / error / unsupported |
| `axes.tsx` | axis, grid, mark and tooltip defaults; the y-axis width estimate; the tooltip component |
| `chartTheme.ts` | measures the design system's own colours and re-measures when the theme flips |
| `cssColor.ts` | `oklch()` / `oklab()` → `rgb()`, because SVG attributes on older Safari do not speak Color 4 |
| `useChart.ts` | the one hook: `idle \| loading \| ready \| error \| unsupported` |
| `rechartsLoader.ts` | the only `import('recharts')` in the module, cached, with a named failure |
| `chartState.ts` | `ChartError` (code + hint + details), `ChartState`, `matchChart` |
| `chartData.ts` | the checks recharts skips: missing keys, exhausted palette, numeric extent, formatters |
| `Sparkline.tsx` | inline SVG trend line, zero dependencies, colour from the `text-*` class you pass |
| `Stat.tsx` | KPI tile: value, label, delta with direction colour, optional sparkline; `StatGroup` for a row |

Nothing is faked anywhere: a missing key, an unreadable palette or an absent package becomes a
`ChartError` with a `code`, a `hint` and the offending names, and the card renders it in place of
the plot. There is no fallback colour and no placeholder series.

## Traps, with the fix

**Tailwind v4 deletes theme variables that no utility uses — this is the one that will bite you.**
`--color-utility-brand-600` is declared in `theme.css` inside `@theme`, but it is only emitted to
the stylesheet if some generated class references it. Read it with `getComputedStyle` and you get
an empty string in light mode and a colour in dark mode (the dark block is plain CSS, so it always
ships). That is why `chartTheme.ts` writes `'bg-utility-brand-600'` out **as a literal string** and
measures a probe element instead of reading the variable: the literal makes Tailwind generate the
class, which makes the variable exist. If you reorder or extend `SERIES_CLASSES`, keep every entry
a complete literal — `` `bg-utility-${family}-600` `` resolves to nothing and every chart will
correctly report `theme_unresolved`.

**A neutral grey serialises as `oklch(98.5% 0 none)`.** `none` is CSS Color 4 for "this component
is missing" and `parseFloat('none')` is `NaN`, so a naive converter throws away half the palette and
the chart claims the theme is missing. `cssColor.ts` treats `none` as zero. If you copy that
converter anywhere else, copy that branch with it.

**`npm i recharts` while the dev server is running does nothing.** Vite resolves dependencies at
startup; the import keeps failing and the card shows `recharts_unavailable`. Restart `npm run dev`.

**A dynamic import that failed once keeps failing for the life of the document.** The browser
records the failure in its module map, so on the phone — where the LAN drops for a second while the
chart chunk is downloading — every later attempt fails instantly with the same error and no network
request. There is deliberately no "try again" button, because it could not work: the fix is to
reload the page, and that is what the error hint says.

**Old iOS Safari has no ResizeObserver, and a responsive chart then draws at 0×0.** That is a blank
card, not an error, so the module checks for it up front and renders the `unsupported` panel naming
the capability. `Stat` and `Sparkline` keep working on those devices — put the headline numbers in
tiles and the charts under them, and the demo degrades instead of disappearing.

**A mistyped `dataKey` renders an empty chart in recharts, silently.** Twenty minutes go into
looking at the fetch. Every wrapper checks that the x key and each series key actually exist and
hold a finite number, and fails with `invalid_data` listing the keys the first row does have.

**Recharts' y-axis is 60px wide no matter what is in it, so `1,240,000` gets clipped.** The width is
computed here from the widest label the formatter will produce, and axis ticks default to compact
notation (`1.2M`) while tooltips keep full precision. Pass `formatTick` to override. On a `stacked`
chart the width is measured against the per-row totals, not the individual values — four series of
900 each put `3.8K` on the axis, which is wider than anything in the data.

**A `null` in a series is drawn as a gap, not as zero** (`connectNulls` is off everywhere). If your
API sends `null` for "no data" the line breaks — that is the honest picture. Send `0` only if the
value really was zero.

**Recharts animates every mark on every re-render.** Past 60 rows that is visible stutter on a
mid-range Android, so animation is capped at 60 rows and switched off entirely under
`prefers-reduced-motion`. Line dots disappear past 24 points for the same reason.

**Pie slice labels are deliberately not drawn.** On a 390px screen they collide with the arcs and
with each other. The legend above the plot and the tooltip carry the labels. Past 8 slices the
chart fails with `palette_exhausted` rather than repeating a colour — group the tail into "Other".

**`text-brand-secondary` is not brand-coloured in dark mode** — the design system remaps it to a
neutral, so anything tinted with it turns grey when the theme flips. `Sparkline` defaults to
`text-utility-brand-600` instead, which is the same colour as chart series 0 in both themes. Use the
`text-utility-*-600` family for anything that has to stay a hue, and `text-success-primary` /
`text-error-primary` for anything that has to stay a meaning.

**The legend is drawn whenever you pass one**, including for a single series. Cartesian charts
default to `legend` on only past one series; `PieChart` always shows it, because a pie with no legend
has no labels at all. Pass `legend={false}` to suppress it.

**The theme toggle must land on `<html>` or `<body>`.** The colour probes are mounted on `<body>`
and a `MutationObserver` watches `class` / `data-theme` / `style` on both. A theme class set on some
inner wrapper will not be noticed, and the charts will keep the previous palette until remount.

## Composes with

`ui-states` (identical `status` vocabulary, so a chart drops straight into an `AsyncBoundary`
`success` branch), `store` / `backend-llm` / `jobs` for the numbers, and `export` for turning the
chart card into a PNG the judges keep.
