// storageCore.ts — the non-React half of the store module: availability probe, typed errors,
// JSON codec, and the same-tab change bus. Imported by useWebStorage.ts / useItems.ts.
// CHANGE: nothing. Add a StoreErrorCode below only if you add a genuinely new failure mode.

/** Which Web Storage area a hook talks to. `local` survives a refresh AND a tab close; `session` dies with the tab. */
export type StorageAreaName = 'local' | 'session';

/**
 * Structurally a Zod schema — anything with `safeParse`. Typed structurally on purpose: this
 * module imports nothing from `zod`, so it compiles against zod 3 or zod 4 alike.
 */
export type Schema<T> = {
  safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: unknown };
};

export type StoreErrorCode =
  | 'read_failed' // getItem() itself threw
  | 'parse_failed' // the stored string is not JSON
  | 'schema_mismatch' // JSON parsed, schema rejected it — a stale shape from an older build
  | 'serialize_failed' // JSON.stringify() threw (circular reference, BigInt, ...)
  | 'write_failed' // setItem() threw — quota exceeded, or storage went read-only
  | 'remove_failed' // removeItem() threw
  | 'request_failed' // fetch never reached the server (network, CORS, abort)
  | 'http_error'; // the server answered with a non-2xx

/**
 * A named failure the UI renders. Never swallowed, never replaced by empty data.
 * Field-compatible with `AppError` from the ui-states module, so `<ErrorState error={...} />` takes it as-is.
 */
export type StoreError = {
  code: StoreErrorCode;
  message: string;
  /** What to actually do about it, in words a teammate can follow mid-demo. */
  hint: string;
  /** HTTP status when the failure came from the network; null for anything local. */
  status: number | null;
  detail?: unknown;
};

export const storeError = (
  code: StoreErrorCode,
  message: string,
  hint: string,
  status: number | null = null,
  detail?: unknown,
): StoreError => ({ code, message, hint, status, detail });

export const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Flatten a Zod error into one line: `items.0.title: Expected string; count: Expected number`. */
export function describeIssues(error: unknown): string {
  const issues = (error as { issues?: unknown })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    const message = (error as { message?: unknown })?.message;
    return typeof message === 'string' && message.trim() ? message : 'the schema rejected the value';
  }
  return issues
    .slice(0, 4)
    .map((raw) => {
      const issue = raw as { path?: unknown; message?: unknown };
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      const text = typeof issue.message === 'string' ? issue.message : 'invalid';
      return path ? `${path}: ${text}` : text;
    })
    .join('; ');
}

// --- availability -----------------------------------------------------------
// Safari Private Browsing keeps `localStorage` on the window with a zero quota: reading works,
// the first setItem throws. "Block all cookies" is worse — touching the property throws
// SecurityError. Both are `unsupported`, never a crash.

export type StorageProbe =
  | { ok: true; area: Storage }
  | { ok: false; reason: string; hint: string };

// The answer cannot change while the page is open, and the probe is a synchronous write —
// on a mid-range Android that is worth avoiding once per hook instance. Cached per area.
const probeCache = new Map<StorageAreaName, StorageProbe>();

export function probeStorage(name: StorageAreaName): StorageProbe {
  const cached = probeCache.get(name);
  if (cached) return cached;
  // Never cached: without a window we are pre-hydration, not permanently unsupported.
  if (typeof window === 'undefined') {
    return { ok: false, reason: 'There is no window object, so there is no Web Storage.', hint: 'Call this hook from a component that only ever renders in the browser.' };
  }
  const result = runProbe(name);
  probeCache.set(name, result);
  return result;
}

function runProbe(name: StorageAreaName): StorageProbe {
  const label = name === 'local' ? 'localStorage' : 'sessionStorage';
  let area: Storage;
  try {
    area = name === 'local' ? window.localStorage : window.sessionStorage;
  } catch (e) {
    return {
      ok: false,
      reason: `Reading window.${label} threw (${errText(e)}) — cookies and site data are blocked for this origin.`,
      hint: 'Safari → Settings → Privacy → turn off "Block all cookies", then reload. In an iframe, allow third-party storage for the parent site.',
    };
  }
  if (!area) {
    return { ok: false, reason: `${label} is not implemented in this browser.`, hint: 'Use a current Safari, Chrome, Firefox or Edge.' };
  }
  const probeKey = `__store_probe_${Math.random().toString(36).slice(2)}`;
  try {
    area.setItem(probeKey, '1');
    area.removeItem(probeKey);
  } catch (e) {
    return {
      ok: false,
      reason: `${label} refused a one-byte test write (${errText(e)}) — there is no room at all for this origin.`,
      hint: 'Either Private Browsing / Incognito with site data blocked (reopen in a normal window), or the 5 MB origin quota is already full (devtools → Application → Storage → Clear site data). Until then nothing survives a reload — the app still runs from memory.',
    };
  }
  return { ok: true, area };
}

// --- codec ------------------------------------------------------------------

const fail = (error: StoreError) => ({ ok: false, error }) as const;

export function encode(value: unknown): { ok: true; raw: string } | { ok: false; error: StoreError } {
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) {
      return fail(storeError('serialize_failed', 'JSON.stringify() returned undefined — the value is a function, a symbol, or plain undefined.', 'Store null instead of undefined, and keep functions out of persisted state.'));
    }
    return { ok: true, raw };
  } catch (e) {
    return fail(storeError('serialize_failed', `JSON.stringify() threw: ${errText(e)}`, 'Persist plain data only — no circular references, DOM nodes, Maps, Sets or BigInt.', null, value));
  }
}

export function decode<T>(raw: string, schema: Schema<T>): { ok: true; value: T } | { ok: false; error: StoreError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(storeError('parse_failed', `The stored value is not JSON: ${errText(e)}`, 'Something other than this hook wrote the key. Call remove() to clear it.', null, raw.slice(0, 200)));
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return fail(storeError('schema_mismatch', `The stored value no longer matches the schema — ${describeIssues(result.error)}`, 'This is data written by an older build. Call remove() to drop it, or widen the schema.', null, parsed));
  }
  return { ok: true, value: result.data };
}

// --- same-tab change bus ----------------------------------------------------
// The `storage` event fires in OTHER tabs only, so every write is announced here too or two
// components on one key drift apart. Subscribers re-read rather than trust a payload.

export type ChangeListener = (originId: number) => void;

const listeners = new Map<string, Set<ChangeListener>>();

const busKey = (area: StorageAreaName, key: string): string => `${area}:${key}`;

// --- in-memory area ---------------------------------------------------------
// Read ONLY when the probe failed, never when storage works, so it hides no failure: the
// status stays `unsupported` and the UI keeps saying nothing is persisted. It exists so two
// components on one key agree for the life of the page — otherwise "still works in memory" is a lie.

const memory = new Map<string, unknown>();

export function memoryRead(area: StorageAreaName, key: string): { present: boolean; value: unknown } {
  const id = busKey(area, key);
  return memory.has(id) ? { present: true, value: memory.get(id) } : { present: false, value: undefined };
}

export const memoryWrite = (area: StorageAreaName, key: string, value: unknown): void => {
  memory.set(busKey(area, key), value);
};

export const memoryClear = (area: StorageAreaName, key: string): void => {
  memory.delete(busKey(area, key));
};

export function subscribeChange(area: StorageAreaName, key: string, fn: ChangeListener): () => void {
  const id = busKey(area, key);
  const set = listeners.get(id) ?? new Set<ChangeListener>();
  listeners.set(id, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(id);
  };
}

export function publishChange(area: StorageAreaName, key: string, originId: number): void {
  const set = listeners.get(busKey(area, key));
  if (!set) return;
  for (const fn of [...set]) fn(originId);
}
