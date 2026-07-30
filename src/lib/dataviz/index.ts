// index.ts — the public surface. Import from '@/lib/dataviz' and nothing deeper.
// COPY: ships with the folder. rechartsLoader is intentionally absent — it is an internal boundary.
// CHANGE: nothing; add a line here when you add a file others should reach.

export { AreaChart, BarChart, LineChart, PieChart } from './Chart';
export type { CartesianChartProps, PieChartProps } from './Chart';

export { Sparkline } from './Sparkline';
export type { SparklineProps } from './Sparkline';

export { Stat, StatGroup } from './Stat';
export type { StatProps } from './Stat';

export { ChartFrame, ChartEmpty, ChartErrorPanel, ChartIdle, ChartLoading, ChartUnsupportedPanel } from './ChartFrame';
export type { ChartFrameProps, LegendItem } from './ChartFrame';

export { useChart } from './useChart';
export type { UseChartOptions } from './useChart';
export { preloadCharts } from './rechartsLoader';

export { ChartError, asChartError, matchChart } from './chartState';
export type { ChartErrorCode, ChartRuntime, ChartState } from './chartState';

export { SERIES_CLASSES, resolveChartTheme, useChartTheme } from './chartTheme';
export type { ChartTheme, ChartThemeResult } from './chartTheme';

export { DEFAULT_TICK, DEFAULT_VALUE, numericExtent, truncateLabel } from './chartData';
export type { ChartDatum, ChartSeries } from './chartData';
