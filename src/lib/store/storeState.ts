// storeState.ts — the union every persisted value lives in, plus its exhaustive matcher.
// COPY: keep next to useWebStorage.ts. You import from useLocal / useSession, not from here.
// CHANGE: nothing. Adding a status here means handling it in useWebStorage.ts too.

import type { StoreError } from './storageCore';

/**
 * Forget a branch and TypeScript stops the build.
 * `loading` is the first render only — the read runs in a layout effect, which commits before
 * the browser paints, so the state is real in code and never flashes on screen. `idle` means
 * storage works and this key was never written. `error` and `unsupported` still carry a usable
 * `value` so the screen renders, while saying plainly that nothing is being persisted.
 */
export type StoreState<T> =
  | { status: 'loading' }
  | { status: 'idle'; value: T }
  | { status: 'ready'; value: T }
  | { status: 'error'; value: T; error: StoreError; raw: string | null }
  | { status: 'unsupported'; value: T; capability: string; reason: string; hint: string };

/** Exhaustive `switch` as an expression — omit a handler and it will not compile. */
export function matchStore<T, R>(
  state: StoreState<T>,
  handlers: {
    loading: () => R;
    idle: (value: T) => R;
    ready: (value: T) => R;
    error: (error: StoreError, value: T) => R;
    unsupported: (reason: string, hint: string, value: T) => R;
  },
): R {
  switch (state.status) {
    case 'loading':
      return handlers.loading();
    case 'idle':
      return handlers.idle(state.value);
    case 'ready':
      return handlers.ready(state.value);
    case 'error':
      return handlers.error(state.error, state.value);
    case 'unsupported':
      return handlers.unsupported(state.reason, state.hint, state.value);
    default: {
      const never: never = state;
      throw new Error(`Unhandled store state: ${JSON.stringify(never)}`);
    }
  }
}
