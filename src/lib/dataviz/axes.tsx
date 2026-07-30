// axes.tsx — axis, grid, mark and tooltip defaults tuned for a phone: nothing clips, nothing overlaps.
// COPY: keep beside Chart.tsx. These are the numbers that stop a 6-inch screen looking broken.
// CHANGE: TICK_FONT_SIZE and Y_AXIS_MAX if the demo runs on a desktop and can afford wider labels.

import type { ChartTheme } from './chartTheme';
import { truncateLabel } from './chartData';
import type { ChartSeries } from './chartData';
import type { AnyChartProps } from './rechartsLoader';

const TICK_FONT_SIZE = 11;
/** Roughly the advance width of a tabular digit at TICK_FONT_SIZE, in px. */
const CHAR_WIDTH = 6.8;
const Y_AXIS_MIN = 30;
const Y_AXIS_MAX = 84;

/** Right margin leaves room for the last x tick; left stays 0 because YAxis brings its own width. */
export const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };

/**
 * Recharts' YAxis defaults to a fixed 60px and clips anything wider. Sizing it from the widest
 * label the formatter will actually produce is the whole fix.
 */
export function estimateYAxisWidth(labels: readonly string[]): number {
  const longest = labels.reduce((n, label) => Math.max(n, label.length), 1);
  return Math.min(Y_AXIS_MAX, Math.max(Y_AXIS_MIN, Math.round(longest * CHAR_WIDTH) + 12));
}

export function gridProps(theme: ChartTheme): AnyChartProps {
  // Horizontal only: vertical gridlines add ink without helping anyone read a value.
  return { stroke: theme.grid, strokeDasharray: '3 3', vertical: false };
}

export function xAxisProps(theme: ChartTheme, dataKey: string, format?: (value: string | number) => string): AnyChartProps {
  return {
    dataKey,
    tickLine: false,
    axisLine: false,
    height: 26,
    tickMargin: 8,
    // preserveStartEnd + a gap keeps the first and last category visible and drops the middle
    // ones as the screen narrows, instead of stacking every label on top of the next.
    interval: 'preserveStartEnd',
    minTickGap: 20,
    tick: { fill: theme.muted, fontSize: TICK_FONT_SIZE },
    tickFormatter: (value: unknown) =>
      format && (typeof value === 'string' || typeof value === 'number') ? format(value) : truncateLabel(value),
  };
}

export function yAxisProps(theme: ChartTheme, width: number, format: (value: number) => string): AnyChartProps {
  return {
    width,
    tickLine: false,
    axisLine: false,
    tickMargin: 4,
    tick: { fill: theme.muted, fontSize: TICK_FONT_SIZE },
    tickFormatter: (value: unknown) => (typeof value === 'number' ? format(value) : String(value ?? '')),
  };
}

export type MarkOptions = { stacked: boolean; curved: boolean; dots: boolean };

/** Per-mark props. `connectNulls` stays off everywhere: a hole in the data is drawn as a hole. */
export function markProps(
  kind: 'line' | 'bar' | 'area',
  series: ChartSeries,
  color: string,
  { stacked, curved, dots }: MarkOptions,
): AnyChartProps {
  const shared: AnyChartProps = { dataKey: series.key, name: series.label ?? series.key };
  if (kind === 'bar') {
    return { ...shared, fill: color, radius: [4, 4, 0, 0], maxBarSize: 48, stackId: stacked ? 'stack' : undefined };
  }
  const curve = { type: curved ? 'monotone' : 'linear', stroke: color, strokeWidth: 2, connectNulls: false };
  if (kind === 'area') {
    return { ...shared, ...curve, fill: color, fillOpacity: 0.16, stackId: stacked ? 'stack' : undefined };
  }
  return {
    ...shared,
    ...curve,
    fill: 'none',
    // Dots on a dense series turn the line into a caterpillar and cost a node each.
    dot: dots ? { r: 2.5, fill: color, strokeWidth: 0 } : false,
    activeDot: { r: 4, fill: color, strokeWidth: 0 },
  };
}

export function tooltipProps(
  theme: ChartTheme,
  kind: 'line' | 'bar' | 'area' | 'pie',
  format: (value: number) => string,
): AnyChartProps {
  return {
    isAnimationActive: false,
    cursor:
      kind === 'bar'
        ? { fill: theme.grid, fillOpacity: 0.35 }
        : kind === 'pie'
          ? false
          : { stroke: theme.grid, strokeWidth: 1 },
    // An element, not a function. Recharts `cloneElement`s an element but `createElement`s a
    // function — and a fresh function every render is a fresh component type, so the tooltip
    // would unmount and remount under the finger on every data tick of a live chart.
    content: <ChartTooltip format={format} />,
  };
}

type TooltipRow = { name: string; value: number | string; color: string };
type TooltipData = { active: boolean; label: string; rows: TooltipRow[] };

/** Recharts hands the content renderer an untyped bag; this reads it defensively and honestly. */
function normalizeTooltip(raw: unknown): TooltipData {
  const bag = (raw ?? {}) as Record<string, unknown>;
  const payload = Array.isArray(bag.payload) ? (bag.payload as Record<string, unknown>[]) : [];
  const rows: TooltipRow[] = payload.map((item) => ({
    name: String(item.name ?? item.dataKey ?? ''),
    value: typeof item.value === 'number' || typeof item.value === 'string' ? item.value : '',
    color: typeof item.color === 'string' ? item.color : typeof item.fill === 'string' ? item.fill : 'currentColor',
  }));
  const label = bag.label === null || bag.label === undefined ? '' : String(bag.label);
  return { active: bag.active === true, label, rows };
}

/** `format` is ours; every other prop is whatever recharts cloned onto the element. */
type ChartTooltipProps = Record<string, unknown> & { format: (value: number) => string };

function ChartTooltip({ format, ...bag }: ChartTooltipProps) {
  const { active, label, rows } = normalizeTooltip(bag);
  if (!active || rows.length === 0) return null;
  return (
    <div className="pointer-events-none rounded-lg border border-secondary bg-primary px-3 py-2 shadow-lg">
      {label && <p className="mb-1 text-xs font-medium text-primary">{label}</p>}
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={`${row.name}-${row.value}`} className="flex items-center gap-2 text-xs text-secondary">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="text-tertiary">{row.name}</span>
            <span className="ml-auto font-medium text-primary">
              {typeof row.value === 'number' ? format(row.value) : row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
