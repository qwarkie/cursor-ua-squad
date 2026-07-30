// Chart.tsx — the four drop-in charts. Theme applied, states rendered, phone axes, recharts lazy.
// COPY: keep beside ChartFrame.tsx / axes.tsx / chartData.ts. This is what app code imports.
// CHANGE: the default `height`, and `emptyLabel` per screen. Everything else is already decided.

import type { ReactNode } from 'react';
import { CHART_MARGIN, estimateYAxisWidth, gridProps, markProps, tooltipProps, xAxisProps, yAxisProps } from './axes';
import { DEFAULT_TICK, DEFAULT_VALUE, assignSeriesColors, numericExtent, validatePieKeys, validateSeriesKeys } from './chartData';
import type { ChartDatum, ChartSeries } from './chartData';
import { ChartEmpty, ChartErrorPanel, ChartFrame, ChartIdle, ChartLoading, ChartUnsupportedPanel } from './ChartFrame';
import type { LegendItem } from './ChartFrame';
import { matchChart } from './chartState';
import { useChart } from './useChart';

const DEFAULT_HEIGHT = 220;
/** Above this many rows recharts' per-mark animation is visible jank on a mid-range Android. */
const ANIMATION_ROW_LIMIT = 60;
/** Above this many points the per-point dots stop being readable and start costing DOM nodes. */
const DOT_ROW_LIMIT = 24;

export type CartesianChartProps = {
  data: readonly ChartDatum[];
  /** Key holding the category / timestamp on each row. */
  x: string;
  /** One entry per plotted key. Colour comes from the theme unless you override it. */
  series: readonly ChartSeries[];
  height?: number;
  title?: string;
  caption?: string;
  /** Defaults to on when there is more than one series. */
  legend?: boolean;
  stacked?: boolean;
  /** Smooth curve. Turn it off for step-like data where a curve invents values between points. */
  curved?: boolean;
  /** Tooltip numbers. Default: full precision, current locale. */
  formatValue?: (value: number) => string;
  /** Y-axis ticks. Default: compact ("12.4K"), which is what keeps the plot from being squeezed. */
  formatTick?: (value: number) => string;
  formatX?: (value: string | number) => string;
  emptyLabel?: string;
  className?: string;
};

function Cartesian(props: CartesianChartProps & { kind: 'line' | 'bar' | 'area' }) {
  const { kind, data, x, series, title, caption, className, emptyLabel } = props;
  const height = props.height ?? DEFAULT_HEIGHT;
  const stacked = props.stacked ?? false;
  const curved = props.curved ?? true;
  const showLegend = props.legend ?? series.length > 1;
  const formatValue = props.formatValue ?? DEFAULT_VALUE;
  const formatTick = props.formatTick ?? DEFAULT_TICK;
  const chart = useChart();

  const frame = (body: ReactNode, legend?: readonly LegendItem[]) => (
    <ChartFrame
      title={title}
      caption={caption}
      height={height}
      legend={showLegend ? legend : undefined}
      className={className}
    >
      {body}
    </ChartFrame>
  );

  return matchChart(chart, {
    idle: () => frame(<ChartIdle />),
    loading: () => frame(<ChartLoading />),
    error: (error) => frame(<ChartErrorPanel error={error} />),
    unsupported: (capability, reason, hint) => frame(<ChartUnsupportedPanel capability={capability} reason={reason} hint={hint} />),
    ready: ({ recharts, theme, animate }) => {
      if (data.length === 0) return frame(<ChartEmpty label={emptyLabel} />);
      const palette = assignSeriesColors(series, theme);
      if (!palette.ok) return frame(<ChartErrorPanel error={palette.error} />);
      const invalid = validateSeriesKeys(data, x, series);
      if (invalid) return frame(<ChartErrorPanel error={invalid} />);

      const legend: LegendItem[] = series.map((s, i) => ({ label: s.label ?? s.key, color: palette.colors[i] }));
      // Lines never stack, so their axis is sized from the individual values whatever `stacked` says.
      const extent = numericExtent(data, series.map((s) => s.key), stacked && kind !== 'line');
      const yWidth = estimateYAxisWidth(extent ? [formatTick(extent.min), formatTick(extent.max)] : ['0']);
      const Root = kind === 'line' ? recharts.LineChart : kind === 'bar' ? recharts.BarChart : recharts.AreaChart;
      const Mark = kind === 'line' ? recharts.Line : kind === 'bar' ? recharts.Bar : recharts.Area;
      const marks = { stacked, curved, dots: kind === 'line' && data.length <= DOT_ROW_LIMIT };

      return frame(
        <recharts.ResponsiveContainer width="100%" height="100%">
          <Root data={data} margin={CHART_MARGIN}>
            <recharts.CartesianGrid {...gridProps(theme)} />
            <recharts.XAxis {...xAxisProps(theme, x, props.formatX)} />
            <recharts.YAxis {...yAxisProps(theme, yWidth, formatTick)} />
            <recharts.Tooltip {...tooltipProps(theme, kind, formatValue)} />
            {series.map((s, i) => (
              <Mark
                key={s.key}
                {...markProps(kind, s, palette.colors[i], marks)}
                isAnimationActive={animate && data.length <= ANIMATION_ROW_LIMIT}
              />
            ))}
          </Root>
        </recharts.ResponsiveContainer>,
        legend,
      );
    },
  });
}

/** Trend over an ordered x — the default for anything with a time axis. */
export function LineChart(props: CartesianChartProps) {
  return <Cartesian kind="line" {...props} />;
}

/** Comparison across categories. Pass `stacked` for parts of a whole per category. */
export function BarChart(props: CartesianChartProps) {
  return <Cartesian kind="bar" {...props} />;
}

/** A line whose magnitude matters. Stack it only when the total is meaningful. */
export function AreaChart(props: CartesianChartProps) {
  return <Cartesian kind="area" {...props} />;
}

export type PieChartProps = {
  data: readonly ChartDatum[];
  /** Key holding the slice label. */
  nameKey: string;
  /** Key holding the slice value. */
  valueKey: string;
  height?: number;
  title?: string;
  caption?: string;
  legend?: boolean;
  /** Cut the middle out — easier to compare arc lengths, and leaves room for nothing else. */
  donut?: boolean;
  formatValue?: (value: number) => string;
  emptyLabel?: string;
  className?: string;
};

/**
 * Slice labels are deliberately not drawn: on a phone they collide with the arcs and with each
 * other. The legend above the plot and the tooltip carry them instead.
 */
export function PieChart(props: PieChartProps) {
  const { data, nameKey, valueKey, title, caption, className, emptyLabel } = props;
  const height = props.height ?? DEFAULT_HEIGHT;
  const showLegend = props.legend ?? true;
  const formatValue = props.formatValue ?? DEFAULT_VALUE;
  const chart = useChart();

  const frame = (body: ReactNode, legend?: readonly LegendItem[]) => (
    <ChartFrame title={title} caption={caption} height={height} legend={showLegend ? legend : undefined} className={className}>
      {body}
    </ChartFrame>
  );

  return matchChart(chart, {
    idle: () => frame(<ChartIdle />),
    loading: () => frame(<ChartLoading />),
    error: (error) => frame(<ChartErrorPanel error={error} />),
    unsupported: (capability, reason, hint) => frame(<ChartUnsupportedPanel capability={capability} reason={reason} hint={hint} />),
    ready: ({ recharts, theme, animate }) => {
      if (data.length === 0) return frame(<ChartEmpty label={emptyLabel} />);
      const invalid = validatePieKeys(data, nameKey, valueKey);
      if (invalid) return frame(<ChartErrorPanel error={invalid} />);
      const slices: ChartSeries[] = data.map((row, i) => ({ key: `${String(row[nameKey] ?? 'slice')}-${i}`, label: String(row[nameKey] ?? '') }));
      const palette = assignSeriesColors(slices, theme);
      if (!palette.ok) return frame(<ChartErrorPanel error={palette.error} />);

      const legend: LegendItem[] = slices.map((s, i) => ({ label: s.label ?? s.key, color: palette.colors[i] }));
      return frame(
        <recharts.ResponsiveContainer width="100%" height="100%">
          <recharts.PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <recharts.Pie
              data={data}
              dataKey={valueKey}
              nameKey={nameKey}
              outerRadius="82%"
              innerRadius={props.donut ? '58%' : 0}
              paddingAngle={1}
              stroke="none"
              label={false}
              labelLine={false}
              isAnimationActive={animate}
            >
              {slices.map((s, i) => (
                <recharts.Cell key={s.key} fill={palette.colors[i]} />
              ))}
            </recharts.Pie>
            <recharts.Tooltip {...tooltipProps(theme, 'pie', formatValue)} />
          </recharts.PieChart>
        </recharts.ResponsiveContainer>,
        legend,
      );
    },
  });
}
