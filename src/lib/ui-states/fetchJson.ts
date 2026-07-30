// fetchJson.ts — fetch that THROWS a typed AppError instead of ever returning fake/placeholder data.
// COPY: drop into src/ui-states/ next to useAsync.ts; import { fetchJson, toAppError } from './fetchJson'.
// CHANGE: HTTP_CODES if your backend uses different error codes; DEFAULT_TIMEOUT_MS if your model calls run long.

/** Typed error parsed from the backend's `{code, message}` body. Never fabricated. */
export type AppError = {
  code: string;
  message: string;
  /** null means the request never reached the server (network, CORS, timeout, client bug). */
  status: number | null;
  detail?: unknown;
};

/** Requests that outlive this are aborted and surfaced as a `timeout` error, never an endless spinner. */
export const DEFAULT_TIMEOUT_MS = 30_000;

const HTTP_CODES: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  408: 'timeout', 409: 'conflict', 413: 'payload_too_large', 422: 'validation_error',
  429: 'rate_limited', 500: 'server_error', 502: 'upstream_unavailable',
  503: 'service_unavailable', 504: 'upstream_timeout',
};

const httpCode = (status: number): string => HTTP_CODES[status] ?? `http_${status}`;

export const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function isAppError(value: unknown): value is AppError {
  const r = asRecord(value);
  return !!r && typeof r.code === 'string' && typeof r.message === 'string';
}

const err = (code: string, message: string, status: number | null = null, detail?: unknown): AppError =>
  ({ code, message, status, detail });

/**
 * Pull `{code,message}` out of a structured body, a FastAPI `{detail:{...}}`, or `{detail:"..."}`.
 * A non-object body yields nothing here so the caller can HTML-filter it first.
 */
function envelope(body: unknown): { code: string | null; message: string | null } {
  const root = asRecord(body);
  if (!root) return { code: null, message: null };
  const nested = asRecord(root.detail);
  const src = nested ?? root;
  return {
    code: str(src.code) ?? str(src.error_code),
    message: str(src.message) ?? str(src.error) ?? str(root.detail),
  };
}

/** FastAPI 422 bodies are `{detail:[{loc,msg,type}]}` — flatten them into something a human can act on. */
function validationMessage(body: unknown): string | null {
  const root = asRecord(body);
  const list = root && Array.isArray(root.detail) ? root.detail : null;
  if (!list || list.length === 0) return null;
  const parts = list.slice(0, 3).map((raw) => {
    const item = asRecord(raw);
    if (!item) return String(raw);
    const loc = Array.isArray(item.loc) ? item.loc.join('.') : null;
    const msg = str(item.msg) ?? str(item.message) ?? 'invalid';
    return loc ? `${loc}: ${msg}` : msg;
  });
  return parts.join('; ');
}

/** Turn a non-OK Response into a typed AppError. Never invents a payload. */
export async function parseErrorResponse(res: Response): Promise<AppError> {
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const env = envelope(body);
  const raw = str(body);
  const plain = raw && !/^\s*<(!doctype|html|\?xml)/i.test(raw) ? raw.slice(0, 300) : null;
  const html = raw && !plain ? 'The server returned an HTML page instead of JSON — the route probably does not exist behind your dev-server proxy.' : null;
  const message =
    env.message ?? validationMessage(body) ?? plain ?? html ?? `Request failed (HTTP ${res.status})`;
  return err(env.code ?? httpCode(res.status), message, res.status, body);
}

/** Browser API rejections a hackathon app actually hits, each with the fix in the message. */
const BY_NAME: Record<string, [code: string, message: string]> = {
  NotAllowedError: ['permission_denied', 'Permission denied. Click the blocked-permission icon in the address bar, allow access, then press retry.'],
  NotFoundError: ['device_not_found', 'No matching device found. Plug one in or pick another input, then retry.'],
  NotReadableError: ['device_in_use', 'The device is already in use by another app or tab. Close it and retry.'],
  SecurityError: ['insecure_context', 'This browser API needs a secure context. Use http://localhost (not a LAN IP) or https://.'],
};

// Chrome "Failed to fetch" / Safari "Load failed" / Firefox "NetworkError..." / Node-undici "fetch failed".
// Only a fallback: fetchJson classifies its own transport failures at the throw site (see networkError).
const FETCH_FAILED = /failed to fetch|fetch failed|networkerror|network request failed|load failed/i;

/** Extra diagnostic undici/Node hangs off `cause` (ECONNREFUSED, bad port, DNS). */
const causeOf = (thrown: unknown): string | undefined => {
  const c = asRecord(thrown)?.cause;
  const r = asRecord(c);
  return str(r?.code) ?? str(r?.message) ?? undefined;
};

const NETWORK_MSG = 'Could not reach the server. Check the API is running, the URL/port is right, and CORS allows this origin.';

const networkError = (thrown: unknown): AppError =>
  err('network_error', NETWORK_MSG, null, causeOf(thrown) ?? (thrown instanceof Error ? thrown.message : String(thrown)));

/** Normalise anything thrown into an AppError. Never guesses "network error" for a client-side bug. */
export function toAppError(thrown: unknown): AppError {
  if (isAppError(thrown)) return thrown;
  const name = thrown instanceof Error ? thrown.name : (str(asRecord(thrown)?.name) ?? '');
  const message = thrown instanceof Error ? thrown.message : String(thrown);

  if (name === 'AbortError') return err('aborted', 'Request cancelled.');
  if (name === 'TimeoutError') return err('timeout', 'The request timed out.');
  const known = BY_NAME[name];
  if (known) return err(known[0], known[1], null, message);

  if (thrown instanceof TypeError) {
    if (FETCH_FAILED.test(message)) return networkError(thrown);
    // A TypeError that is NOT a transport failure is a bug in your own code. Reporting it as
    // "network error" is the classic 20-minute misdiagnosis, so name it for what it is.
    return err('client_type_error', `${message} — this is a client-side bug, not a network failure.`, null, thrown);
  }
  return err('unexpected_error', message || 'Unexpected client error.', null, thrown);
}

function buildHeaders(body: BodyInit | null | undefined, extra: HeadersInit | undefined): Headers {
  // Must go through Headers: `{...init.headers}` silently yields {} for a Headers instance
  // and would drop an Authorization token without any warning.
  const headers = new Headers(extra);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  // ONLY for string bodies. Setting this on FormData/Blob/URLSearchParams strips the multipart
  // boundary the browser generates and the server rejects the upload with a confusing 422.
  if (typeof body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return headers;
}

const formatMs = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${ms}ms`);

export type FetchJsonInit = RequestInit & {
  /** Abort and raise a `timeout` AppError after this many ms. 0 disables. Default 30s. */
  timeoutMs?: number;
};

/**
 * fetch + JSON that throws a typed AppError on failure and never returns mock/placeholder data.
 * A 204 or empty body resolves to `null`, which useAsync classifies as `empty` — not a fake success.
 */
export async function fetchJson<T>(input: RequestInfo | URL, init: FetchJsonInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...rest } = init;
  const controller = new AbortController();
  const forward = () => controller.abort();
  let timedOut = false;

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  const fire = () => {
    timedOut = true;
    controller.abort();
  };
  const timer = timeoutMs > 0 ? setTimeout(fire, timeoutMs) : null;

  const timedOutError = () =>
    err('timeout', `No response after ${formatMs(timeoutMs)}. The request was aborted — is the server stuck?`);

  try {
    let res: Response;
    try {
      res = await fetch(input, { ...rest, signal: controller.signal, headers: buildHeaders(rest.body, headers) });
    } catch (thrown) {
      if (timedOut) throw timedOutError();
      // fetch() itself rejecting with a TypeError is ALWAYS a transport failure. Classifying it
      // here beats sniffing the message, which differs per browser and per Node version.
      if (thrown instanceof TypeError) throw networkError(thrown);
      throw thrown;
    }

    if (!res.ok) throw await parseErrorResponse(res);
    if (res.status === 204) return null as unknown as T;
    const text = await res.text();
    if (!text.trim()) return null as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw err(
        'bad_response',
        'Server returned a non-JSON body. An HTML page here usually means the dev-server proxy 404ed — check the route and your Vite proxy prefix.',
        res.status,
        text.slice(0, 500),
      );
    }
  } catch (thrown) {
    // Covers a timeout that fired while the body was still streaming.
    if (timedOut && !isAppError(thrown)) throw timedOutError();
    throw thrown;
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}
