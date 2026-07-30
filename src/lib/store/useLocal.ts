// useLocal.ts — state that survives a refresh, a tab close and a phone locking itself.
// COPY: this + useWebStorage.ts + storeState.ts + storageCore.ts into src/lib/store/. Needs `npm i zod`.
// CHANGE: nothing here — pass the key, the schema and the fallback in from your component.

import { useWebStorage } from './useWebStorage';
import type { UseStoreOptions, UseStoreResult } from './useWebStorage';
import type { Schema } from './storageCore';

// Re-exported so a component only ever imports from '@/lib/store/useLocal'.
export { matchStore } from './useWebStorage';
export type { StoreState, UseStoreOptions, UseStoreResult } from './useWebStorage';
export type { Schema, StoreError, StoreErrorCode } from './storageCore';

/**
 * `const { state, set, remove } = useLocal('notes', NotesSchema, []);`
 *
 * The value is validated with your Zod schema on every read, including reads triggered by
 * another tab. A payload written by an older build therefore surfaces as `status: 'error'`
 * with the failing field named — it never reaches your component as the wrong shape.
 *
 * Writes are mirrored to every other `useLocal` on the same key: other tabs through the
 * `storage` event, other components in this tab through an in-page bus.
 */
export function useLocal<T>(
  key: string,
  schema: Schema<T>,
  fallback: T,
  options: UseStoreOptions = {},
): UseStoreResult<T> {
  return useWebStorage('local', key, schema, fallback, options);
}
