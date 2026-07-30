// chartData.ts — the checks recharts does not do: a mistyped dataKey draws a blank chart silently.
// COPY: ships with the folder. Every wrapper runs these before it renders a single mark.
// CHANGE: DEFAULT_TICK / DEFAULT_VALUE formatting if the product speaks a fixed locale or currency.

import { ChartError } from './chartState';
import type { ChartTheme } from './chartTheme';

/** One row. Values may be null — a gap in a line is real information and is drawn as a gap. */
export type ChartDatum = Record<string, string | number | null | undefined>;

/**
 * One plotted key. `color` overrides the palette slot — pass a value measured from the design
 * system, e.g. `theme.negative` off the `ready` runtime, so it still follows a theme flip.
 */
export type ChartSeries = { key: string; label?: string; color?: string };

/** Axis ticks: compact, because "12.4K" fits on a phone and "12,431" pushes the plot off-screen. */
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
/** Tooltips and labels: full precision, because that is where the exact number is expected. */
const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export const DEFAULT_TICK = (value: number): string => compact.format(value);
export const DEFAULT_VALUE = (value: number): string => exact.format(value);

/** Truncate a category label so the x-axis does not turn into overlapping mush on a narrow screen. */
export function truncateLabel(value: unknown, max = 10): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Palette slot per series — never wrapped around, because two series sharing a colour is a lie
 * about the data. Past the palette the caller is told to pass explicit colours or group the tail.
 */
export function assignSeriesColors(
  series: readonly ChartSeries[],
  theme: ChartTheme,
): { ok: true; colors: string[] } | { ok: false; error: ChartError } {
  const colors: string[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const explicit = series[i].color;
    const slot = theme.series[i];
    if (explicit) colors.push(explicit);
    else if (slot) colors.push(slot);
    else {
      return {
        ok: false,
        error: new ChartError(
          'palette_exhausted',
          `${series.length} series were requested but the palette has ${theme.series.length} distinct colours.`,
          `Colour stops carrying meaning past ${theme.series.length} categories: group the tail into one "Other" series, or pass \`color\` on the extra ones.`,
          series.slice(theme.series.length).map((s) => s.key),
        ),
      };
    }
  }
  return { ok: true, colors };
}

/** Every key the chart was told to plot has to exist and hold at least one finite number. */
export function validateSeriesKeys(
  data: readonly ChartDatum[],
  xKey: string,
  series: readonly ChartSeries[],
): ChartError | null {
  const problems: string[] = [];
  if (!data.some((row) => row[xKey] !== undefined)) {
    problems.push(`"${xKey}" (the x axis) is not a key on any row`);
  }
  for (const s of series) {
    if (!data.some((row) => Number.isFinite(Number(row[s.key])))) {
      problems.push(`"${s.key}" holds no finite number on any row`);
    }
  }
  if (problems.length === 0) return null;
  return new ChartError(
    'invalid_data',
    `The chart was pointed at ${problems.length} key${problems.length === 1 ? '' : 's'} the data does not have.`,
    `Available keys on the first row: ${Object.keys(data[0] ?? {}).join(', ') || '(the row is empty)'}.`,
    problems,
  );
}

/** Same check for a pie: one label key, one numeric key. */
export function validatePieKeys(data: readonly ChartDatum[], nameKey: string, valueKey: string): ChartError | null {
  const problems: string[] = [];
  if (!data.some((row) => row[nameKey] !== undefined)) problems.push(`"${nameKey}" (the slice label) is not a key on any row`);
  if (!data.some((row) => Number.isFinite(Number(row[valueKey])))) problems.push(`"${valueKey}" holds no finite number on any row`);
  if (problems.length === 0) return null;
  return new ChartError(
    'invalid_data',
    'The pie was pointed at keys the data does not have.',
    `Available keys on the first row: ${Object.keys(data[0] ?? {}).join(', ') || '(the row is empty)'}.`,
    problems,
  );
}

/**
 * Smallest and largest finite value across the plotted keys — used to size the y axis.
 * Pass `stacked` for a stacked chart: the axis there runs to the per-row *total*, and sizing it
 * from the individual values makes the widest tick wider than the gutter reserved for it.
 */
export function numericExtent(
  data: readonly ChartDatum[],
  keys: readonly string[],
  stacked = false,
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of data) {
    // Recharts stacks positives upward and negatives downward, so they accumulate separately.
    let positive = 0;
    let negative = 0;
    let seen = false;
    for (const key of keys) {
      const value = Number(row[key]);
      if (!Number.isFinite(value)) continue;
      seen = true;
      if (stacked) {
        if (value >= 0) positive += value;
        else negative += value;
      } else {
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (stacked && seen) {
      if (negative < min) min = negative;
      if (positive > max) max = positive;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}
