// searchHttp.ts — the transport under searchClient.ts: one POST with a timeout, an abort and a typed failure.
// COPY: with the rest of kit/search into src/lib/search/. Nothing outside this module imports it directly.
// CHANGE: DEFAULT_BASE_URL if search_router is mounted somewhere other than /api/search.

import { searchError } from './searchTypes';
import type { SearchError } from './searchTypes';

export const DEFAULT_BASE_URL = '/api/search';
/** search_router.py caps its own Tavily read at 20s, so this only has to outlive that. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;
/**
 * Grounding is a full model turn, and kit/backend-llm caps ONE call at TIMEOUT_S = 60s.
 * A ceiling under that kills requests the backend would have answered — which is why the
 * two phases do not share a number. ground.py may re-ask once when a citation is out of
 * range; that path needs more, so raise timeoutMs if you ever see `timeout` on it.
 */
export const DEFAULT_GROUND_TIMEOUT_MS = 90_000;

export interface SearchFetchOptions {
  baseUrl?: string;
  /** Overrides BOTH phase defaults. Leave unset unless a phase is genuinely timing out. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The body did not match the contract. Carries the offending payload so you can read it in the UI. */
export function shapeError(path: string, what: string, body: unknown): SearchError {
  return searchError('bad_response', `${path} returned an unexpected shape: ${what}.`, 200, body);
}

/** Pull {code,message} out of our envelope, FastAPI's {detail:{...}}, or a 422 validation list. */
export function errorFromBody(status: number, body: string, url: string): SearchError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const root = record(parsed);
  const nested = root ? record(root.detail) : null;
  const source = nested ?? root;
  if (source) {
    const code = text(source.code);
    const message = text(source.message) ?? text(source.error);
    if (code && message) return searchError(code, message, status, source.detail);
  }
  if (root && Array.isArray(root.detail)) {
    const first = record(root.detail[0]);
    const where = first && Array.isArray(first.loc) ? first.loc.join('.') : 'body';
    const why = (first && text(first.msg)) ?? 'invalid input';
    return searchError('invalid_request', `${where}: ${why}`, status, root.detail);
  }
  if (status === 404) {
    return searchError(
      'route_not_found',
      `POST ${url} is not mounted. Add app.include_router(search_router) in backend/main.py and restart the API.`,
      status,
    );
  }
  return searchError(
    `http_${status}`,
    `POST ${url} failed with ${status} and no readable body: ${body.slice(0, 160) || '(empty)'}. If this is a search failure, backend/main.py is missing register_error_handlers(app).`,
    status,
  );
}

/** POST JSON, return parsed JSON. Every failure leaves here as a SearchError with a code. */
export async function postSearch(
  path: string,
  payload: unknown,
  timeoutMs: number,
  options: SearchFetchOptions,
): Promise<unknown> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}${path}`;
  // An `abort` event that already fired can never fire again, so a listener added now would
  // never run and the request would go out on a signal the caller already cancelled.
  if (options.signal?.aborted) throw searchError('aborted', 'The request was cancelled before it was sent.');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort);
  try {
    let response: Response;
    let raw: string;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // Read the body inside the same guard: the same timer aborts a slow body, and that
      // rejection has to surface as `timeout`, not as an anonymous `unexpected_error`.
      raw = await response.text();
    } catch (cause) {
      if (timedOut) {
        throw searchError(
          'timeout',
          `${url} did not answer within ${timeoutMs}ms. Raise timeoutMs, or drop searchDepth back to 'basic'.`,
        );
      }
      if (controller.signal.aborted) {
        throw searchError('aborted', 'The request was superseded or the component unmounted.');
      }
      const why = cause instanceof Error ? cause.message : String(cause);
      throw searchError(
        'network_error',
        `${url} never reached the backend (${why}). Start it with \`make dev\` — the Vite proxy forwards /api to it.`,
      );
    }
    if (!response.ok) throw errorFromBody(response.status, raw, url);
    if (!raw) {
      throw searchError('empty_response', `${url} returned ${response.status} with an empty body.`, response.status);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw searchError('bad_response', `${url} returned a body that is not JSON: ${raw.slice(0, 160)}`, response.status);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
