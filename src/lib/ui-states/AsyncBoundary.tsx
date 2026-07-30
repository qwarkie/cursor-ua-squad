// AsyncBoundary.tsx — renders an AsyncState<T>. Every slot is a REQUIRED prop, so skipping a state is a compile error.
// COPY: place next to useAsync.ts; import { AsyncBoundary } and spread defaultSlots() from states.tsx for the non-success branches.
// CHANGE: nothing usually — customise by passing your own slot functions instead of the defaults.

import type { ReactNode } from 'react';
import type { AppError, AsyncState } from './useAsync';
import { match } from './useAsync';

/** The five non-success branches. `defaultSlots()` in states.tsx returns exactly this object. */
export type AsyncSlots = {
  idle: () => ReactNode;
  loading: () => ReactNode;
  error: (error: AppError, retry: () => void) => ReactNode;
  empty: () => ReactNode;
  unsupported: (capability: string, hint: string) => ReactNode;
};

export type AsyncBoundaryProps<T> = AsyncSlots & {
  state: AsyncState<T>;
  /** Required: an error state with no way back is a dead end. Pass `retry` from useAsync. */
  onRetry: () => void;
  success: (data: T) => ReactNode;
  className?: string;
};

/**
 * <AsyncBoundary state={state} onRetry={retry} {...defaultSlots({ noun: 'runs' })} success={(d) => <List items={d} />} />
 */
export function AsyncBoundary<T>(props: AsyncBoundaryProps<T>) {
  const { state, onRetry, className } = props;
  const body = match<T, ReactNode>(state, {
    idle: () => props.idle(),
    loading: () => props.loading(),
    error: (error) => props.error(error, onRetry),
    empty: () => props.empty(),
    unsupported: (capability, hint) => props.unsupported(capability, hint),
    success: (data) => props.success(data),
  });
  return (
    <div className={className ? `ui-boundary ${className}` : 'ui-boundary'} data-status={state.status} aria-busy={state.status === 'loading'}>
      {body}
    </div>
  );
}

/**
 * Same contract for a value you already hold (e.g. a state lifted into a store):
 * keeps the exhaustiveness guarantee without the wrapper div.
 */
export function AsyncSwitch<T>(props: AsyncBoundaryProps<T>) {
  const { state, onRetry } = props;
  return (
    <>
      {match<T, ReactNode>(state, {
        idle: () => props.idle(),
        loading: () => props.loading(),
        error: (error) => props.error(error, onRetry),
        empty: () => props.empty(),
        unsupported: (capability, hint) => props.unsupported(capability, hint),
        success: (data) => props.success(data),
      })}
    </>
  );
}
