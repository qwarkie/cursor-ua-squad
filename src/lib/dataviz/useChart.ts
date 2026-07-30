// useChart.ts — the single hook: loads recharts, resolves the theme, reports what a device cannot do.
// COPY: ships with the folder. The four wrappers in Chart.tsx call it for you; call it yourself
// CHANGE: nothing. Pass { enabled: false } to hold a chart at `idle` until its data exists.

import { useEffect, useMemo, useState } from 'react';
import { ChartError, asChartError } from './chartState';
import type { ChartState } from './chartState';
import { useChartTheme } from './chartTheme';
import { loadRecharts } from './rechartsLoader';
import type { RechartsModule } from './rechartsLoader';

export type UseChartOptions = {
  /** Default true. False keeps the state at `idle` and skips the import entirely. */
  enabled?: boolean;
};

type ModuleState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; recharts: RechartsModule }
  | { status: 'error'; error: ChartError };

type Support = { ok: true } | { ok: false; capability: string; reason: string; hint: string };

/**
 * Two device facts a retry cannot fix. ResizeObserver is the real one: recharts sizes its
 * <svg> from it, and without it every chart renders at 0x0 and looks like a blank card.
 */
function detectSupport(): Support {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      ok: false,
      capability: 'DOM',
      reason: 'Charts read their colours from the live stylesheet, which needs a document.',
      hint: 'Render the chart on the client — inside an effect, or behind a mount guard.',
    };
  }
  if (typeof window.ResizeObserver === 'undefined') {
    return {
      ok: false,
      capability: 'ResizeObserver',
      reason: 'This browser cannot report element size changes, so a responsive chart has no width to draw into.',
      hint: 'Update to iOS 13.4+ / Safari 13.1+ or a current Chrome. Numbers rendered as <Stat/> and <Sparkline/> still work here.',
    };
  }
  return { ok: true };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * const chart = useChart();
 * matchChart(chart, { idle, loading, error, unsupported, ready: ({ recharts, theme }) => ... })
 */
export function useChart(options: UseChartOptions = {}): ChartState {
  const enabled = options.enabled !== false;
  const support = useMemo(detectSupport, []);
  const theme = useChartTheme();

  const [module, setModule] = useState<ModuleState>({ status: 'idle' });
  // Read on the very first render, then kept live — a chart must not animate once on mount
  // and only afterwards notice that the user asked for stillness.
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(media.matches);
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!enabled || !support.ok) return;
    let cancelled = false;
    setModule({ status: 'loading' });
    loadRecharts().then(
      (recharts) => {
        if (!cancelled) setModule({ status: 'ready', recharts });
      },
      (thrown: unknown) => {
        if (!cancelled) setModule({ status: 'error', error: asChartError(thrown) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, support.ok]);

  return useMemo<ChartState>(() => {
    if (!support.ok) {
      return { status: 'unsupported', capability: support.capability, reason: support.reason, hint: support.hint };
    }
    if (!enabled) return { status: 'idle' };
    if (module.status === 'error') return { status: 'error', error: module.error };
    if (!theme.ok) {
      return {
        status: 'error',
        error: new ChartError(
          'theme_unresolved',
          'The design-system colour variables are not on this page, so there is nothing to draw with.',
          'Import the theme once in main.tsx: `import "@/styles/globals.css";`.',
          theme.missing.slice(0, 8),
        ),
      };
    }
    if (module.status !== 'ready') return { status: 'loading' };
    return {
      status: 'ready',
      runtime: { recharts: module.recharts, theme: theme.theme, animate: !reduced },
    };
  }, [support, enabled, module, theme, reduced]);
}
