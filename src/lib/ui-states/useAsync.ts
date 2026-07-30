// useAsync.ts — async hook returning a DISCRIMINATED UNION so TypeScript refuses to compile a half-handled request.
// COPY: drop this file (with fetchJson.ts / AsyncBoundary.tsx / states.tsx / states.css) into src/ui-states/.
// CHANGE: `defaultIsEmpty()` if "empty" means something else in your app; everything else is usually fine as-is.

import { useCallback, useEffect, useRef, useState } from 'react';
import { asRecord, toAppError } from './fetchJson';
import type { AppError } from './fetchJson';

// Re-exported so `import { useAsync, fetchJson } from './useAsync'` works from one path.
export { fetchJson, parseErrorResponse, toAppError, isAppError, DEFAULT_TIMEOUT_MS } from './fetchJson';
export type { AppError, FetchJsonInit } from './fetchJson';

/** The only shape a caller ever sees. Every branch must be handled. */
export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: AppError }
  | { status: 'empty' }
  | { status: 'unsupported'; capability: string; hint: string }
  | { status: 'success'; data: T };

/** A browser capability the call depends on (getUserMedia, WebSocket, clipboard, ...). */
export type Capability = { name: string; check: () => boolean; hint: string };

export type UseAsyncOptions<T> = {
  /** Run once on mount. Only use this when the runner takes NO arguments beyond the signal. */
  immediate?: boolean;
  /** Decide whether a successful payload is actually "empty". Null/undefined is always empty. */
  isEmpty?: (data: T) => boolean;
  /** Guard the call behind a browser capability; failing the check yields `unsupported`. */
  capability?: Capability;
};

export type UseAsyncResult<T, A extends unknown[]> = {
  state: AsyncState<T>;
  /**
   * Starts the request. Resolves with the state that was committed, or `{status:'loading'}`
   * when the result was discarded because a newer run superseded it or the component unmounted.
   */
  run: (...args: A) => Promise<AsyncState<T>>;
  /** Re-run with the arguments of the last attempt — wire this to the error retry button. */
  retry: () => Promise<AsyncState<T>>;
  reset: () => void;
};

function defaultIsEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'string') return data.trim().length === 0;
  const r = asRecord(data);
  if (r) {
    const list = r.items ?? r.results ?? r.data;
    if (Array.isArray(list)) return list.length === 0;
  }
  return false;
}

/**
 * Null/undefined short-circuits to empty BEFORE any custom isEmpty runs, so a 204 or empty body
 * can never blow up a callback like `(t) => t.segments.length === 0` with a null dereference.
 * If a custom isEmpty does throw, it is reported as itself instead of masquerading as a fetch failure.
 */
function computeEmpty<T>(data: T, isEmpty: ((data: T) => boolean) | undefined): boolean {
  if (data === null || data === undefined) return true;
  if (!isEmpty) return defaultIsEmpty(data);
  try {
    return isEmpty(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw {
      code: 'empty_check_failed',
      message: `isEmpty() threw: ${message}. The response shape is not what the type says it is.`,
      status: null,
      detail: data,
    } as AppError;
  }
}

function capabilityFailure<T>(cap: Capability | undefined): AsyncState<T> | null {
  if (!cap) return null;
  let ok = false;
  try {
    ok = cap.check();
  } catch {
    ok = false;
  }
  return ok ? null : { status: 'unsupported', capability: cap.name, hint: cap.hint };
}

/**
 * const { state, run, retry } = useAsync((signal) => fetchJson<Run[]>('/api/runs', { signal }), { immediate: true });
 * Always forward `signal` into fetch so superseded requests are actually cancelled, not just ignored.
 */
export function useAsync<T, A extends unknown[] = []>(
  fn: (signal: AbortSignal, ...args: A) => Promise<T>,
  options: UseAsyncOptions<T> = {},
): UseAsyncResult<T, A> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optRef = useRef(options);
  optRef.current = options;

  const [state, setState] = useState<AsyncState<T>>(
    () => capabilityFailure<T>(options.capability) ?? { status: 'idle' },
  );

  const runId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastArgs = useRef<A | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<AsyncState<T>> => {
    const blocked = capabilityFailure<T>(optRef.current.capability);
    if (blocked) {
      setState(blocked);
      return blocked;
    }
    const id = ++runId.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastArgs.current = args;
    setState({ status: 'loading' });
    try {
      const data = await fnRef.current(controller.signal, ...args);
      if (id !== runId.current || !mounted.current) return { status: 'loading' };
      const next: AsyncState<T> = computeEmpty(data, optRef.current.isEmpty)
        ? { status: 'empty' }
        : { status: 'success', data };
      setState(next);
      return next;
    } catch (thrown) {
      const error = toAppError(thrown);
      // A superseded or unmounted run must not overwrite the newer state.
      if (error.code === 'aborted' || id !== runId.current || !mounted.current) return { status: 'loading' };
      const next: AsyncState<T> = { status: 'error', error };
      setState(next);
      return next;
    }
  }, []);

  const retry = useCallback(() => run(...((lastArgs.current ?? []) as A)), [run]);

  const reset = useCallback(() => {
    runId.current += 1;
    abortRef.current?.abort();
    lastArgs.current = null;
    setState(capabilityFailure<T>(optRef.current.capability) ?? { status: 'idle' });
  }, []);

  const immediate = options.immediate === true;
  useEffect(() => {
    if (immediate) void run(...([] as unknown as A));
  }, [immediate, run]);

  return { state, run, retry, reset };
}

/** Exhaustive `switch` as an expression — omit a handler and it will not compile. */
export function match<T, R>(
  state: AsyncState<T>,
  handlers: {
    idle: () => R;
    loading: () => R;
    error: (error: AppError) => R;
    empty: () => R;
    unsupported: (capability: string, hint: string) => R;
    success: (data: T) => R;
  },
): R {
  switch (state.status) {
    case 'idle':
      return handlers.idle();
    case 'loading':
      return handlers.loading();
    case 'error':
      return handlers.error(state.error);
    case 'empty':
      return handlers.empty();
    case 'unsupported':
      return handlers.unsupported(state.capability, state.hint);
    case 'success':
      return handlers.success(state.data);
    default: {
      const never: never = state;
      throw new Error(`Unhandled async state: ${JSON.stringify(never)}`);
    }
  }
}
