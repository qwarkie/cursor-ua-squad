// useItems.ts — the client for store_router.py: a validated list of rows in one collection.
// COPY: into src/lib/store/ next to itemsClient.ts and storageCore.ts. Needs the router mounted.
// CHANGE: nothing here — pass the collection and the schema in from your component.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE, DEFAULT_LIMIT, request, validate } from './itemsClient';
import { storeError } from './storageCore';
import type { Item, Outcome, RawItem } from './itemsClient';
import type { Schema, StoreError } from './storageCore';

// Re-exported so a component only ever imports from '@/lib/store/useItems'.
export type { Item, Outcome } from './itemsClient';
export type { StoreError, StoreErrorCode } from './storageCore';

/**
 * `loading` and `error` carry the last list that was actually read from the server, so a
 * refresh does not blank the screen and a failed save does not delete the demo in front of
 * a judge. The status still tells the truth — `error` means the list on screen is stale.
 */
export type ItemsState<T> =
  | { status: 'idle' }
  | { status: 'loading'; items: Item<T>[] }
  | { status: 'ready'; items: Item<T>[] }
  | { status: 'error'; error: StoreError; items: Item<T>[] }
  | { status: 'unsupported'; capability: string; reason: string; hint: string };

export type UseItemsResult<T> = {
  state: ItemsState<T>;
  /** Create a row, or overwrite one by passing its id. The list reloads on success. */
  save: (payload: unknown, id?: string) => Promise<Outcome<Item<T>>>;
  remove: (id: string) => Promise<Outcome<number>>;
  clear: () => Promise<Outcome<number>>;
  reload: () => Promise<ItemsState<T>>;
};

/**
 * `const notes = useItems('notes', NoteSchema);`
 *
 * Loads on mount and whenever `collection` changes; every mutation reloads from the server,
 * so what you render is what is actually on disk — no optimistic copy that can drift.
 */
export function useItems<T>(
  collection: string,
  schema: Schema<T>,
  options: { autoLoad?: boolean; limit?: number } = {},
): UseItemsResult<T> {
  const { autoLoad = true, limit = DEFAULT_LIMIT } = options;
  const supported = typeof fetch === 'function';
  const unsupported = useMemo(
    () =>
      ({
        status: 'unsupported',
        capability: 'fetch',
        reason: 'This browser has no fetch(), so the app cannot talk to the backend at all.',
        hint: 'Open the demo in a current Safari, Chrome or Firefox rather than an embedded WebView.',
      }) as const,
    [],
  );

  const [state, setState] = useState<ItemsState<T>>(() => (supported ? { status: 'idle' } : unsupported));
  const schemaRef = useRef(schema);
  schemaRef.current = schema;
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const runId = useRef(0);
  // The last list the server actually confirmed. Never invented — empty until a read succeeds.
  const knownRef = useRef<Item<T>[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const commit = useCallback((next: ItemsState<T>): ItemsState<T> => {
    if (next.status === 'ready') knownRef.current = next.items;
    if (alive.current) setState(next);
    return next;
  }, []);

  const reload = useCallback(async (): Promise<ItemsState<T>> => {
    if (!supported) return commit(unsupported);
    const id = ++runId.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    commit({ status: 'loading', items: knownRef.current });
    const url = `${BASE}?collection=${encodeURIComponent(collection)}&limit=${limit}`;
    const res = await request<{ items: RawItem[] }>(url, { signal: controller.signal });
    // A superseded or unmounted run must not overwrite newer state.
    if (id !== runId.current || !alive.current) return { status: 'loading', items: knownRef.current };
    if (!res.ok) return commit({ status: 'error', error: res.error, items: knownRef.current });
    const checked = validate(res.data.items, schemaRef.current);
    if (!checked.ok) return commit({ status: 'error', error: checked.error, items: knownRef.current });
    return commit({ status: 'ready', items: checked.data });
  }, [collection, limit, supported, unsupported, commit]);

  const mutate = useCallback(
    async <R>(url: string, init: RequestInit): Promise<Outcome<R>> => {
      if (!supported) {
        commit(unsupported);
        return { ok: false, error: storeError('request_failed', unsupported.reason, unsupported.hint) };
      }
      const res = await request<R>(url, init);
      if (!res.ok) commit({ status: 'error', error: res.error, items: knownRef.current });
      else await reload();
      return res;
    },
    [supported, unsupported, commit, reload],
  );

  const save = useCallback(
    async (payload: unknown, id?: string): Promise<Outcome<Item<T>>> => {
      const body = JSON.stringify(id ? { collection, payload, id } : { collection, payload });
      const res = await mutate<RawItem>(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) return res;
      const checked = validate([res.data], schemaRef.current);
      return checked.ok ? { ok: true, data: checked.data[0] } : { ok: false, error: checked.error };
    },
    [collection, mutate],
  );

  const remove = useCallback(
    async (id: string): Promise<Outcome<number>> => {
      const res = await mutate<{ deleted: number }>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return res.ok ? { ok: true, data: res.data.deleted } : res;
    },
    [mutate],
  );

  const clear = useCallback(async (): Promise<Outcome<number>> => {
    const res = await mutate<{ deleted: number }>(`${BASE}?collection=${encodeURIComponent(collection)}`, { method: 'DELETE' });
    return res.ok ? { ok: true, data: res.data.deleted } : res;
  }, [collection, mutate]);

  useEffect(() => {
    if (autoLoad) void reload();
  }, [autoLoad, reload]);

  return useMemo(() => ({ state, save, remove, clear, reload }), [state, save, remove, clear, reload]);
}

/** Exhaustive `switch` as an expression — omit a handler and it will not compile. */
export function matchItems<T, R>(
  state: ItemsState<T>,
  handlers: {
    idle: () => R;
    loading: (stale: Item<T>[]) => R;
    ready: (items: Item<T>[]) => R;
    error: (error: StoreError, stale: Item<T>[]) => R;
    unsupported: (reason: string, hint: string) => R;
  },
): R {
  switch (state.status) {
    case 'idle':
      return handlers.idle();
    case 'loading':
      return handlers.loading(state.items);
    case 'ready':
      return handlers.ready(state.items);
    case 'error':
      return handlers.error(state.error, state.items);
    case 'unsupported':
      return handlers.unsupported(state.reason, state.hint);
    default: {
      const never: never = state;
      throw new Error(`Unhandled items state: ${JSON.stringify(never)}`);
    }
  }
}
