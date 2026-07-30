// chartTheme.ts — asks the browser what the design system paints, and hands charts those colours.
// COPY: keep beside cssColor.ts. Nothing is hardcoded, so light/dark follows the app for free.
// CHANGE: SERIES_CLASSES if the product wants a different categorical order — keep them literal.

import { useEffect, useMemo, useState } from 'react';
import { toCssColor } from './cssColor';

/**
 * Every class below is written out in full on purpose. Tailwind v4 only emits a theme variable
 * when some utility references it, so `bg-utility-${family}-600` built at runtime would resolve
 * to nothing. These literals are what makes the palette exist in the stylesheet at all.
 *
 * `-600` is the theme-stable slot: light mode paints the 600 ramp (dark enough on white), dark
 * mode remaps it to 400 (light enough on near-black). Hue order is spread so that neighbours in
 * this list stay tellable apart on a 6-inch screen; slot 0 is the brand colour, so a one-series
 * chart is the product's own colour.
 */
export const SERIES_CLASSES = [
  'bg-utility-brand-600',
  'bg-utility-emerald-600',
  'bg-utility-orange-600',
  'bg-utility-sky-600',
  'bg-utility-pink-600',
  'bg-utility-yellow-600',
  'bg-utility-indigo-600',
  'bg-utility-slate-600',
] as const;

type ProbeProperty = 'color' | 'backgroundColor' | 'borderTopColor';

const CORE_PROBES = {
  text: { className: 'text-primary', property: 'color' },
  muted: { className: 'text-tertiary', property: 'color' },
  grid: { className: 'border-secondary', property: 'borderTopColor' },
  positive: { className: 'text-success-primary', property: 'color' },
  negative: { className: 'text-error-primary', property: 'color' },
} as const satisfies Record<string, { className: string; property: ProbeProperty }>;

type CoreKey = keyof typeof CORE_PROBES;

/** Inherited by the probes. A `color` probe that reads this back proves its class never applied. */
const SENTINEL = 'rgb(1, 2, 3)';

export type ChartTheme = {
  /** Resolved categorical colours, in order. Index i belongs to series i — never wrapped around. */
  series: readonly string[];
  /** Axis names and pie labels. */
  text: string;
  /** Tick labels and legend text. */
  muted: string;
  /** Gridlines and the tooltip cursor. */
  grid: string;
  /** A delta the user wants to go up. */
  positive: string;
  /** A delta the user does not want to go up. */
  negative: string;
};

export type ChartThemeResult =
  | { ok: true; theme: ChartTheme; missing: readonly string[] }
  | { ok: false; missing: readonly string[] };

/** Attributes a theme switch is likely to write. Untitled UI's dark mode is the `.dark-mode` class. */
const WATCHED_ATTRS = ['class', 'data-theme', 'style'];

/**
 * Mounts one off-screen element per token inside `root`, reads what the browser computed, and
 * removes them again. Measuring the rendered result rather than a variable name means the chart
 * cannot drift from the rest of the UI. A class that paints nothing lands in `missing`; no colour
 * is ever invented in its place.
 */
export function resolveChartTheme(root: HTMLElement | null): ChartThemeResult {
  if (!root) return { ok: false, missing: ['document (colours can only be measured in a DOM)'] };

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;color:${SENTINEL}`;
  root.appendChild(host);

  try {
    // Every element is created before anything is read, so the browser recalculates style once.
    const coreEls = new Map<CoreKey, HTMLElement>();
    for (const key of Object.keys(CORE_PROBES) as CoreKey[]) coreEls.set(key, probe(host, CORE_PROBES[key].className));
    const seriesEls = SERIES_CLASSES.map((className) => probe(host, className));

    const missing: string[] = [];
    const core: Partial<Record<CoreKey, string>> = {};
    for (const key of Object.keys(CORE_PROBES) as CoreKey[]) {
      const spec = CORE_PROBES[key];
      const color = read(coreEls.get(key), spec.property);
      if (color) core[key] = color;
      else missing.push(spec.className);
    }

    const series: string[] = [];
    seriesEls.forEach((el, i) => {
      const color = read(el, 'backgroundColor');
      if (color) series.push(color);
      else missing.push(SERIES_CLASSES[i]);
    });

    const { text, muted, grid, positive, negative } = core;
    if (!text || !muted || !grid || !positive || !negative || series.length === 0) {
      return { ok: false, missing };
    }
    return { ok: true, theme: { series, text, muted, grid, positive, negative }, missing };
  } finally {
    host.remove();
  }
}

function probe(host: HTMLElement, className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  // A border needs a style and a width before its colour is worth reading.
  el.style.borderStyle = 'solid';
  el.style.borderWidth = '1px';
  host.appendChild(el);
  return el;
}

function read(el: HTMLElement | undefined, property: ProbeProperty): string | null {
  if (!el) return null;
  const raw = getComputedStyle(el)[property];
  if (!raw) return null;
  // Fully transparent means the class produced no paint; the sentinel means it never applied.
  if (raw === 'transparent' || raw.replace(/\s/g, '') === 'rgba(0,0,0,0)') return null;
  if (property === 'color' && raw === SENTINEL) return null;
  return toCssColor(raw);
}

/**
 * The theme as the document currently renders it, re-measured when the theme flips.
 * Probes are mounted on `<body>`, so a `.dark-mode` class on either <html> or <body> is inherited.
 */
export function useChartTheme(): ChartThemeResult {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bump = () => setVersion((v) => v + 1);

    const observer = new MutationObserver(bump);
    const targets = [document.documentElement, document.body].filter(Boolean);
    for (const target of targets) observer.observe(target, { attributes: true, attributeFilter: WATCHED_ATTRS });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', bump);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', bump);
    };
  }, []);

  // Measured during render, not in an effect: an effect would paint one frame of "no colours"
  // before the real ones arrived. The probes are appended and removed synchronously, outside the
  // React root, so nothing React owns is touched. `version` is the dependency, the arguments are not.
  return useMemo(() => {
    if (typeof document === 'undefined' || !document.body) return resolveChartTheme(null);
    return resolveChartTheme(document.body);
  }, [version]);
}
