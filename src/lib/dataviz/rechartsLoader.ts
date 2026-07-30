// rechartsLoader.ts — the one place `recharts` is imported, and it happens lazily, once, at runtime.
// COPY: ships with the folder. Nothing else in the module may import 'recharts' directly.
// CHANGE: add a name to REQUIRED_PARTS when you start drawing with another recharts component.

import type { ComponentType, ReactNode } from 'react';
import { ChartError } from './chartState';

/**
 * The wrappers pass recharts' own props straight through, so this boundary is deliberately
 * structural: we depend on the components existing, not on the exact shape of their props.
 * Every prop this module actually passes is checked against recharts' runtime behaviour, not
 * against its .d.ts — which is why a recharts minor bump cannot break the build here.
 */
export type AnyChartProps = Record<string, unknown> & { children?: ReactNode };
export type ChartPart = ComponentType<AnyChartProps>;

const REQUIRED_PARTS = [
  'ResponsiveContainer',
  'LineChart',
  'Line',
  'BarChart',
  'Bar',
  'AreaChart',
  'Area',
  'PieChart',
  'Pie',
  'Cell',
  'XAxis',
  'YAxis',
  'CartesianGrid',
  'Tooltip',
] as const;

export type RechartsModule = { [K in (typeof REQUIRED_PARTS)[number]]: ChartPart };

let pending: Promise<RechartsModule> | null = null;

/**
 * Loads recharts once and caches the promise. A failed load clears the cache so a retry
 * (or a dev-server restart after `npm i recharts`) actually re-attempts the import.
 */
export function loadRecharts(): Promise<RechartsModule> {
  if (!pending) {
    pending = importRecharts().catch((thrown: unknown) => {
      pending = null;
      throw thrown;
    });
  }
  return pending;
}

/** Warm the chunk before the first chart mounts — call it while the data is still being fetched. */
export function preloadCharts(): void {
  void loadRecharts().catch(() => {
    // Swallowed on purpose: this is a prefetch. The real load runs again inside useChart and
    // surfaces the identical failure there, where a component can render it.
  });
}

async function importRecharts(): Promise<RechartsModule> {
  let mod: Record<string, unknown>;
  try {
    // ~120 kB parsed. Deferred to here so the first paint of the app never waits on it.
    mod = (await import('recharts')) as unknown as Record<string, unknown>;
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    throw new ChartError(
      'recharts_unavailable',
      `recharts could not be imported: ${message}`,
      'Not installed? `npm i recharts`, then restart the Vite dev server — a package added while it is ' +
        'running is not picked up. Already installed? The chunk failed to download (a phone that dropped ' +
        'off the LAN): reload the page, because a dynamic import that failed once keeps failing for the ' +
        'life of the document.',
    );
  }

  const missing = REQUIRED_PARTS.filter((name) => {
    const part = mod[name];
    // Function components and memo/forwardRef objects both count; null and undefined do not.
    return part === null || part === undefined || (typeof part !== 'function' && typeof part !== 'object');
  });
  if (missing.length > 0) {
    throw new ChartError(
      'recharts_incomplete',
      `recharts loaded but is missing ${missing.length} component${missing.length === 1 ? '' : 's'} this module draws with.`,
      'Install a 2.x or 3.x release of recharts: `npm i recharts@latest`.',
      missing.slice(),
    );
  }
  return mod as unknown as RechartsModule;
}
