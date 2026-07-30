// itemsClient.ts — the React-free half of the /api/items client: URLs, HTTP error mapping,
// and payload validation. Imported by useItems.ts; you never call it directly.
// CHANGE: BASE if you mounted store_router.py under a prefix other than /api.

import { errText, storeError } from './storageCore';
import type { Schema, StoreError } from './storageCore';

export const BASE = '/api/items';
export const DEFAULT_LIMIT = 100;

/** One row as the server returns it, with `payload` already checked against your schema. */
export type Item<T> = { id: string; collection: string; payload: T; created_at: number; updated_at: number };

export type RawItem = { id: string; collection: string; payload: unknown; created_at: number; updated_at: number };

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: StoreError };

/** Turn a non-2xx into a named error. The backend sends {detail:{error,message,hint}}; use it when it is there. */
export async function readError(res: Response): Promise<StoreError> {
  const body = await res.json().catch(() => null);
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as { error?: string; message?: string; hint?: string };
    return storeError('http_error', d.message ?? `HTTP ${res.status}`, d.hint ?? 'Read the backend log for the traceback.', res.status, d.error);
  }
  if (Array.isArray(detail)) {
    const msg = detail.map((i) => (i as { msg?: string }).msg ?? '').filter(Boolean).join('; ');
    return storeError('http_error', msg || `HTTP ${res.status}`, 'The request did not match the endpoint contract — check the collection name and payload.', res.status, detail);
  }
  const hint =
    res.status === 404
      ? `A bare 404 on ${BASE} means the router is not mounted. Add app.include_router(store_router) to backend/main.py.`
      : res.status === 502 || res.status === 503 || res.status === 504
        ? 'The dev proxy answered for the backend, which means the backend is not running. Start it and reload.'
        : 'Read the backend log for the traceback.';
  return storeError('http_error', `HTTP ${res.status} ${res.statusText}`, hint, res.status);
}

export async function request<R>(url: string, init: RequestInit): Promise<Outcome<R>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? storeError('request_failed', 'The request was cancelled.', 'Expected when the component unmounted or a newer request superseded this one.')
        : storeError('request_failed', `The request never reached the server: ${errText(e)}`, 'Start the backend (make dev). On a phone, load the app through the Vite dev server so /api is proxied — never hardcode a LAN IP.'),
    };
  }
  if (!res.ok) return { ok: false, error: await readError(res) };
  try {
    return { ok: true, data: (await res.json()) as R };
  } catch (e) {
    return {
      ok: false,
      error: storeError('parse_failed', `The server answered ${res.status} with a body that is not JSON: ${errText(e)}`, 'Usually an HTML error page from a proxy. Open the URL in a browser tab to see it.', res.status),
    };
  }
}

/** One bad row fails the whole list, loudly. Silently dropping it would hide a real data bug. */
export function validate<T>(rows: RawItem[], schema: Schema<T>): Outcome<Item<T>[]> {
  const items: Item<T>[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row.payload);
    if (!parsed.success) {
      return {
        ok: false,
        error: storeError('schema_mismatch', `Row ${row.id} does not match the schema.`, `It was written by an older build. Delete it: DELETE ${BASE}/${row.id}`, null, parsed.error),
      };
    }
    items.push({ id: row.id, collection: row.collection, payload: parsed.data, created_at: row.created_at, updated_at: row.updated_at });
  }
  return { ok: true, data: items };
}
