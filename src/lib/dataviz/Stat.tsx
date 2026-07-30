// Stat.tsx — the KPI tile: one number, its label, and a delta whose colour says good or bad.
// COPY: standalone apart from Sparkline.tsx. No recharts, so a metrics row paints immediately.
// CHANGE: `invertDelta` per metric — down is good for latency, cost and error rate.

import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat(undefined, { signDisplay: 'exceptZero', maximumFractionDigits: 1 });

export type StatProps = {
  label: string;
  /** A number is formatted for the current locale; a string is printed exactly as given. */
  value: string | number;
  formatValue?: (value: number) => string;
  /** Signed change against the previous period. Omit it when there is nothing to compare against. */
  delta?: number;
  /** Appended to the formatted delta — usually '%' or 'ms'. */
  deltaSuffix?: string;
  /** What the delta is measured against, e.g. "vs last week". */
  deltaLabel?: string;
  formatDelta?: (value: number) => string;
  /** Set when a fall is the good outcome: latency, cost, error rate. */
  invertDelta?: boolean;
  /** Oldest first. Draws a sparkline tinted with the delta's direction colour. */
  trend?: readonly number[];
  footnote?: string;
  className?: string;
};

export function Stat({
  label,
  value,
  formatValue = (v) => number.format(v),
  delta,
  deltaSuffix = '',
  deltaLabel,
  formatDelta = (v) => signed.format(v),
  invertDelta = false,
  trend,
  footnote,
  className = '',
}: StatProps) {
  const hasDelta = delta !== undefined && Number.isFinite(delta);
  const direction = !hasDelta || delta === 0 ? 'flat' : (delta as number) > 0 ? 'up' : 'down';
  const good = direction === 'flat' ? 'flat' : (direction === 'up') !== invertDelta ? 'good' : 'bad';
  const tone = good === 'good' ? 'text-success-primary' : good === 'bad' ? 'text-error-primary' : 'text-tertiary';
  // With no delta there is no good or bad, so the trend takes the brand colour rather than the
  // grey that would read as "nothing happened here".
  const trendTone = hasDelta ? tone : 'text-utility-brand-600';

  return (
    <div className={`flex flex-col gap-1 rounded-xl border border-secondary bg-primary p-4 ${className}`}>
      <p className="text-sm text-tertiary">{label}</p>

      <div className="flex items-end justify-between gap-3">
        <p className="text-display-xs font-semibold text-primary tabular-nums">{renderValue(value, formatValue)}</p>
        {trend && trend.length > 1 && <Sparkline values={trend} className={tone} area label={`${label} trend`} width={72} height={24} />}
      </div>

      {delta !== undefined && (
        <p className={`flex items-center gap-1 text-sm ${tone}`}>
          <span aria-hidden="true">{direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'}</span>
          <span className="tabular-nums">
            {Number.isFinite(delta) ? `${formatDelta(delta)}${deltaSuffix}` : 'not a number'}
          </span>
          {deltaLabel && <span className="text-tertiary">{deltaLabel}</span>}
        </p>
      )}

      {footnote && <p className="text-xs text-quaternary">{footnote}</p>}
    </div>
  );
}

/** A NaN or Infinity reaching a KPI tile is a bug upstream — it is named, never printed as "—". */
function renderValue(value: string | number, format: (value: number) => string) {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return <span className="text-md text-error-primary">{String(value)}</span>;
  return format(value);
}

/** A row of tiles that stays readable at 360px: two across on a phone, four on a laptop. */
export function StatGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${className}`}>{children}</div>;
}
