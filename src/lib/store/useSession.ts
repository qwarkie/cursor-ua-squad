// useSession.ts — state that survives a refresh but dies with the tab. Use it for a wizard
// step or an in-progress draft that must not leak into the next visitor's demo run.
// COPY: this + useWebStorage.ts + storeState.ts + storageCore.ts into src/lib/store/.

import { useWebStorage } from './useWebStorage';
import type { UseStoreOptions, UseStoreResult } from './useWebStorage';
import type { Schema } from './storageCore';

// Re-exported so a component only ever imports from '@/lib/store/useSession'.
export { matchStore } from './useWebStorage';
export type { StoreState, UseStoreOptions, UseStoreResult } from './useWebStorage';
export type { Schema, StoreError, StoreErrorCode } from './storageCore';

/**
 * `const { state, set } = useSession('draft', DraftSchema, EMPTY_DRAFT);`
 *
 * Identical to `useLocal` except for the lifetime: `sessionStorage` is scoped to one tab,
 * so there is no cross-tab sync to speak of — duplicating a tab copies the values once and
 * the two then drift apart. Components inside this tab still stay in sync with each other.
 */
export function useSession<T>(
  key: string,
  schema: Schema<T>,
  fallback: T,
  options: UseStoreOptions = {},
): UseStoreResult<T> {
  return useWebStorage('session', key, schema, fallback, options);
}
