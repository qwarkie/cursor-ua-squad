// useWebStorage.ts — the shared React implementation behind useLocal and useSession.
// COPY: keep next to storageCore.ts. You import useLocal / useSession, not this file.
// CHANGE: nothing. Behaviour is driven by the arguments the two wrappers pass in.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  decode,
  describeIssues,
  encode,
  errText,
  memoryClear,
  memoryRead,
  memoryWrite,
  probeStorage,
  publishChange,
  storeError,
  subscribeChange,
} from './storageCore';
import type { Schema, StorageAreaName } from './storageCore';
import type { StoreState } from './storeState';

// Re-exported so nothing downstream has to know the union lives in its own file.
export { matchStore } from './storeState';
export type { StoreState } from './storeState';

export type UseStoreOptions = {
  /** Prepended to every key. Two demos on the same localhost:5173 share one origin — a prefix keeps them apart. */
  prefix?: string;
};

export type UseStoreResult<T> = {
  state: StoreState<T>;
  /** Write through to storage. Returns the state that was committed, so you can act on a failed write immediately. */
  set: (next: T | ((prev: T) => T)) => StoreState<T>;
  /** Delete the key and fall back to the initial value. This is the fix for a `schema_mismatch`. */
  remove: () => StoreState<T>;
  /** Re-read and re-validate. Wire this to the retry button on the error state. */
  reload: () => StoreState<T>;
  /** The real key in the area, prefix included — paste it into devtools → Application → Storage. */
  storageKey: string;
};

let instanceSeq = 0;

export function useWebStorage<T>(
  areaName: StorageAreaName,
  key: string,
  schema: Schema<T>,
  fallback: T,
  options: UseStoreOptions = {},
): UseStoreResult<T> {
  const storageKey = (options.prefix ?? '') + key;
  const label = areaName === 'local' ? 'localStorage' : 'sessionStorage';

  // Identifies this hook instance on the same-tab bus so it does not react to its own writes.
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++instanceSeq;

  // Captured on mount: an inline `{}` fallback re-created every render must not restart anything.
  const fallbackRef = useRef(fallback);
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  // The probe performs a real test write — the only way to catch Safari Private Browsing,
  // where the API is present and the quota is zero. Cached per area inside storageCore, so
  // this is one synchronous write per page load, not one per hook instance.
  const probe = useMemo(() => probeStorage(areaName), [areaName]);

  const [state, setState] = useState<StoreState<T>>({ status: 'loading' });
  const valueRef = useRef(fallback);

  const commit = useCallback((next: StoreState<T>): StoreState<T> => {
    if (next.status !== 'loading') valueRef.current = next.value;
    setState(next);
    return next;
  }, []);

  const read = useCallback((): StoreState<T> => {
    const base = fallbackRef.current;
    if (!probe.ok) {
      // Nothing is persisted, but a sibling component on this key may have set a value this
      // page load. Revalidate it — a memory value is still only as trustworthy as the schema.
      const held = memoryRead(areaName, storageKey);
      const unsupported = (value: T): StoreState<T> =>
        ({ status: 'unsupported', value, capability: label, reason: probe.reason, hint: probe.hint });
      if (!held.present) return unsupported(base);
      const checked = schemaRef.current.safeParse(held.value);
      if (!checked.success) {
        return {
          status: 'error',
          value: base,
          raw: null,
          error: storeError('schema_mismatch', `The in-memory value for "${storageKey}" does not match this schema — ${describeIssues(checked.error)}`, 'Two components share this key with different schemas. Give one of them its own key or its own prefix.', null, held.value),
        };
      }
      return unsupported(checked.data);
    }
    let raw: string | null;
    try {
      raw = probe.area.getItem(storageKey);
    } catch (e) {
      const error = storeError('read_failed', `${label}.getItem("${storageKey}") threw: ${errText(e)}`, 'Storage access was revoked mid-session. Reload the page.');
      return { status: 'error', value: base, raw: null, error };
    }
    if (raw === null) return { status: 'idle', value: base };
    const decoded = decode(raw, schemaRef.current);
    if (!decoded.ok) return { status: 'error', value: base, raw, error: decoded.error };
    return { status: 'ready', value: decoded.value };
  }, [probe, storageKey, label, areaName]);

  const readRef = useRef(read);
  readRef.current = read;

  // Layout effects run after render and before paint, so the loading state never flashes,
  // and the render pass itself stays free of storage side effects.
  const keyRef = useRef(storageKey);
  useLayoutEffect(() => {
    if (keyRef.current !== storageKey) {
      keyRef.current = storageKey;
      valueRef.current = fallbackRef.current;
    }
    commit(read());
  }, [read, commit, storageKey]);

  // Cross-tab (`storage`, other tabs only) and same-tab (bus) changes both land here.
  // The bus is subscribed even when the probe failed, so siblings still agree in memory.
  useEffect(() => {
    const sync = () => commit(readRef.current());
    const unsubscribe = subscribeChange(areaName, storageKey, (originId) => {
      if (originId !== idRef.current) sync();
    });
    if (!probe.ok) return unsubscribe;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== probe.area) return;
      // A null key means the whole area was cleared, which includes ours.
      if (event.key !== null && event.key !== storageKey) return;
      sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      unsubscribe();
    };
  }, [probe, storageKey, areaName, commit]);

  const set = useCallback(
    (next: T | ((prev: T) => T)): StoreState<T> => {
      // Same convention as useState: a function argument is treated as an updater.
      const value = typeof next === 'function' ? (next as (prev: T) => T)(valueRef.current) : next;
      if (!probe.ok) {
        // Nothing reaches disk, but siblings on this key see it for the life of the page.
        memoryWrite(areaName, storageKey, value);
        publishChange(areaName, storageKey, idRef.current);
        return commit({ status: 'unsupported', value, capability: label, reason: probe.reason, hint: probe.hint });
      }
      const encoded = encode(value);
      if (!encoded.ok) return commit({ status: 'error', value, raw: null, error: encoded.error });
      try {
        probe.area.setItem(storageKey, encoded.raw);
      } catch (e) {
        const error = storeError('write_failed', `${label} rejected a ${encoded.raw.length}-character write: ${errText(e)}`, `The origin is at its quota (roughly 5 MB). Call remove() on keys you no longer need, or keep images and audio out of ${label}.`);
        return commit({ status: 'error', value, raw: encoded.raw, error });
      }
      publishChange(areaName, storageKey, idRef.current);
      return commit({ status: 'ready', value });
    },
    [probe, storageKey, areaName, label, commit],
  );

  const remove = useCallback((): StoreState<T> => {
    const base = fallbackRef.current;
    if (!probe.ok) {
      memoryClear(areaName, storageKey);
      publishChange(areaName, storageKey, idRef.current);
      return commit({ status: 'unsupported', value: base, capability: label, reason: probe.reason, hint: probe.hint });
    }
    try {
      probe.area.removeItem(storageKey);
    } catch (e) {
      const error = storeError('remove_failed', `${label}.removeItem("${storageKey}") threw: ${errText(e)}`, 'Storage access was revoked mid-session. Reload the page.');
      return commit({ status: 'error', value: base, raw: null, error });
    }
    publishChange(areaName, storageKey, idRef.current);
    return commit({ status: 'idle', value: base });
  }, [probe, storageKey, areaName, label, commit]);

  const reload = useCallback((): StoreState<T> => commit(readRef.current()), [commit]);

  return useMemo(() => ({ state, set, remove, reload, storageKey }), [state, set, remove, reload, storageKey]);
}
