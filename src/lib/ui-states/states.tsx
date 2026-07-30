// states.tsx — the default Loading / Error / Empty / Unsupported / Idle views plus AsyncButton (pending is a required prop).
// COPY: place next to AsyncBoundary.tsx and `import './states.css'` once in your app entry.
// CHANGE: the copy in `defaultSlots({ noun, idleHint })` per screen; icons/wording below are yours to edit.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { AsyncSlots } from './AsyncBoundary';
import type { AppError } from './useAsync';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="ui-spinner" role="status" aria-label={label} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="ui-state ui-state--loading" role="status" aria-live="polite">
      <Spinner label={label} />
      <p className="ui-state__title">{label}</p>
      <div className="ui-skeleton-group" aria-hidden="true">
        <span className="ui-skeleton" style={{ width: '82%' }} />
        <span className="ui-skeleton" style={{ width: '64%' }} />
        <span className="ui-skeleton" style={{ width: '73%' }} />
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: AppError; onRetry: () => void }) {
  return (
    <div className="ui-state ui-state--error" role="alert">
      <div className="ui-state__badge ui-state__badge--error" aria-hidden="true">!</div>
      <p className="ui-state__title">Request failed</p>
      <p className="ui-state__message">{error.message}</p>
      <div className="ui-code-row">
        <code className="ui-code">{error.code}</code>
        {error.status !== null && <code className="ui-code ui-code--muted">HTTP {error.status}</code>}
      </div>
      <button type="button" className="ui-btn ui-btn--primary" onClick={onRetry}>
        Try again
      </button>
      {error.detail !== undefined && error.detail !== null && (
        <details className="ui-details">
          <summary>Response body</summary>
          <pre className="ui-pre">{safeStringify(error.detail)}</pre>
        </details>
      )}
    </div>
  );
}

export function Empty({ noun = 'results', hint, action }: { noun?: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="ui-state ui-state--empty">
      <div className="ui-state__badge" aria-hidden="true">∅</div>
      <p className="ui-state__title">No {noun} yet</p>
      <p className="ui-state__message">{hint ?? `The request succeeded but returned no ${noun}.`}</p>
      {action}
    </div>
  );
}

export function Unsupported({ capability, hint }: { capability: string; hint: string }) {
  return (
    <div className="ui-state ui-state--unsupported" role="note">
      <div className="ui-state__badge ui-state__badge--warn" aria-hidden="true">⚠</div>
      <p className="ui-state__title">{capability} is unavailable in this browser</p>
      <p className="ui-state__message">{hint}</p>
      <p className="ui-state__footnote">
        Everything else on this page still works — only the {capability.toLowerCase()} feature is disabled.
      </p>
    </div>
  );
}

export function Idle({ hint = 'Nothing has been requested yet.', action }: { hint?: string; action?: ReactNode }) {
  return (
    <div className="ui-state ui-state--idle">
      <div className="ui-state__badge" aria-hidden="true">→</div>
      <p className="ui-state__message">{hint}</p>
      {action}
    </div>
  );
}

/**
 * A button that cannot exist without a pending state: `pending` is required, not optional.
 * <AsyncButton pending={state.status === 'loading'} onClick={() => run()}>Analyze</AsyncButton>
 */
export type AsyncButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  pendingLabel?: string;
  variant?: 'primary' | 'ghost';
};

export function AsyncButton({ pending, pendingLabel = 'Working…', variant = 'primary', children, className, disabled, ...rest }: AsyncButtonProps) {
  const classes = ['ui-btn', `ui-btn--${variant}`, pending ? 'is-pending' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button {...rest} type={rest.type ?? 'button'} className={classes} disabled={disabled || pending} aria-busy={pending}>
      {pending && <Spinner label={pendingLabel} />}
      <span>{pending ? pendingLabel : children}</span>
    </button>
  );
}

/**
 * The five non-success slots, ready to spread into <AsyncBoundary>.
 * Override any single one by listing it AFTER the spread.
 */
export function defaultSlots(opts: { noun?: string; idleHint?: string; emptyHint?: string; loadingLabel?: string; emptyAction?: ReactNode } = {}): AsyncSlots {
  return {
    idle: () => <Idle hint={opts.idleHint} />,
    loading: () => <Loading label={opts.loadingLabel} />,
    error: (error, retry) => <ErrorState error={error} onRetry={retry} />,
    empty: () => <Empty noun={opts.noun} hint={opts.emptyHint} action={opts.emptyAction} />,
    unsupported: (capability, hint) => <Unsupported capability={capability} hint={hint} />,
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
