// ChartFrame.tsx — the card every chart lives in, plus the panel for each non-ready state.
// COPY: keep beside Chart.tsx. The frame keeps its height in every state, so nothing jumps.
// CHANGE: the copy strings, and the card classes if charts sit inside an existing panel already.

import type { ReactNode } from 'react';
import type { ChartError } from './chartState';

export type LegendItem = { label: string; color: string };

export type ChartFrameProps = {
  title?: string;
  caption?: string;
  /** Plot height in px. The card reserves it in every state so loading does not resize the page. */
  height: number;
  legend?: readonly LegendItem[];
  className?: string;
  children: ReactNode;
};

export function ChartFrame({ title, caption, height, legend, className = '', children }: ChartFrameProps) {
  return (
    <figure className={`flex w-full flex-col gap-3 rounded-xl border border-secondary bg-primary p-4 ${className}`}>
      {title && <figcaption className="text-sm font-medium text-primary">{title}</figcaption>}
      {/* Whether a legend is worth showing is the caller's decision — passing one and getting
          nothing back is the kind of five-minute mystery this module exists to avoid. */}
      {legend && legend.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {legend.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5 text-xs text-tertiary">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {/* Runtime geometry: the plot needs a pixel height before recharts can measure anything. */}
      <div className="w-full" style={{ height }}>
        {children}
      </div>
      {caption && <p className="text-xs text-tertiary">{caption}</p>}
    </figure>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">{children}</div>;
}

export function ChartIdle({ hint = 'No data plotted yet.' }: { hint?: string }) {
  return (
    <Centered>
      <p className="text-sm text-tertiary">{hint}</p>
    </Centered>
  );
}

export function ChartLoading({ label = 'Drawing the chart…' }: { label?: string }) {
  return (
    <Centered>
      <div
        className="size-8 animate-spin rounded-full border-2 border-secondary border-t-transparent"
        role="status"
        aria-label={label}
      />
      <p className="text-sm text-tertiary">{label}</p>
    </Centered>
  );
}

export function ChartEmpty({ label = 'No rows to plot.' }: { label?: string }) {
  return (
    <Centered>
      <p className="text-sm text-tertiary">{label}</p>
      <p className="text-xs text-quaternary">The query ran and came back with nothing — this is not a failure.</p>
    </Centered>
  );
}

export function ChartErrorPanel({ error, onRetry }: { error: ChartError; onRetry?: () => void }) {
  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto rounded-lg bg-error-primary p-4" role="alert">
      <p className="text-sm font-semibold text-error-primary">{error.message}</p>
      <p className="text-xs text-secondary">{error.hint}</p>
      {error.details.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {error.details.slice(0, 6).map((detail) => (
            <li key={detail} className="text-xs text-tertiary">
              {detail}
            </li>
          ))}
          {error.details.length > 6 && (
            <li className="text-xs text-quaternary">…and {error.details.length - 6} more.</li>
          )}
        </ul>
      )}
      <p className="text-xs text-quaternary">{error.code}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-auto self-start rounded-lg border border-secondary bg-primary px-3 py-1.5 text-xs text-primary"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function ChartUnsupportedPanel({ capability, reason, hint }: { capability: string; reason: string; hint: string }) {
  return (
    <div className="flex h-full w-full flex-col justify-center gap-1.5 rounded-lg bg-warning-primary p-4" role="note">
      <p className="text-sm font-semibold text-warning-primary">{capability} is unavailable on this device</p>
      <p className="text-xs text-secondary">{reason}</p>
      <p className="text-xs text-tertiary">{hint}</p>
    </div>
  );
}
