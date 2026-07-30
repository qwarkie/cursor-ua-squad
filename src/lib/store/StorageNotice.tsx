// StorageNotice.tsx — renders the two states a persisted value can fail in, and nothing else.
// COPY: into src/lib/store/ next to useLocal.ts. Drop it under any component that persists state.
// CHANGE: the wording. Swap the plain buttons for <Button> from src/components/base/buttons if you prefer.

import type { StoreState } from './storeState';

const ROW = 'rounded-xl border p-4 text-sm';
// min-h-9 keeps the tap target above the 36px a thumb needs; the hover/focus states are the
// only feedback a phone gives that the tap landed at all.
const ACTION =
  'min-h-9 rounded-lg border border-secondary bg-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';

/**
 * `<StorageNotice state={notes.state} onDiscard={notes.remove} onRetry={notes.reload} />`
 *
 * Renders nothing while loading, idle or ready — the happy path is your component's job.
 * On `unsupported` it says persistence is off and why; on `error` it names the failing field
 * and offers the one action that fixes it. It never hides the failure behind a fallback.
 */
export function StorageNotice({
  state,
  onDiscard,
  onRetry,
}: {
  state: StoreState<unknown>;
  onDiscard?: () => void;
  onRetry?: () => void;
}) {
  if (state.status === 'unsupported') {
    return (
      <div className={`${ROW} border-secondary bg-warning-primary`} role="note">
        <p className="font-semibold text-warning-primary">Nothing is being saved on this device</p>
        <p className="mt-1 text-tertiary">{state.reason}</p>
        <p className="mt-2 text-tertiary">{state.hint}</p>
        <p className="mt-2 text-tertiary">Everything on this page still works — it just will not survive a reload.</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={`${ROW} border-error bg-error-primary`} role="alert">
        <p className="font-semibold text-error-primary">Saved data could not be restored</p>
        <p className="mt-1 text-primary">{state.error.message}</p>
        <p className="mt-2 text-tertiary">{state.error.hint}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="rounded-md bg-secondary px-2 py-1 text-xs text-tertiary">{state.error.code}</code>
          {onRetry && (
            <button type="button" className={ACTION} onClick={onRetry}>
              Try again
            </button>
          )}
          {onDiscard && (
            <button type="button" className={ACTION} onClick={onDiscard}>
              Discard stored value
            </button>
          )}
        </div>
        {state.raw !== null && (
          <details className="mt-3">
            <summary className="cursor-pointer text-tertiary">What was stored</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-secondary p-2 text-xs text-tertiary">{state.raw}</pre>
          </details>
        )}
      </div>
    );
  }

  return null;
}
