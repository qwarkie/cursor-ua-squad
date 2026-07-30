// visionClient.ts — the two POSTs, with timeout, abort, and a typed error for every failure path.
// COPY: with the rest of kit/vision into src/lib/vision/. Used by useVision.ts; usable on its own.
// CHANGE: DEFAULT_BASE_URL if your router is mounted somewhere other than /api/vision.

import { visionError } from './visionTypes';
import type { DetectResult, ExtractResult, VisionError, VisionImage } from './visionTypes';

export const DEFAULT_BASE_URL = '/api/vision';
/**
 * Must outlast the BACKEND, not one model. clients.py caps each SDK call at 60s and provider.py
 * falls through MODELS, so a slow first model plus a fallback is ~120s of legitimate work.
 * A shorter client timeout would report `timeout` while the backend was still about to answer.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface VisionFetchOptions {
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Pull {code,message} out of our envelope, FastAPI's {detail:{...}}, or a 422 validation list. */
function errorFromBody(status: number, body: string, url: string): VisionError {
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
    if (code && message) return visionError(code, message, status, source.detail);
  }
  if (root && Array.isArray(root.detail)) {
    const first = record(root.detail[0]);
    const where = first && Array.isArray(first.loc) ? first.loc.join('.') : 'body';
    const why = (first && text(first.msg)) ?? 'invalid input';
    return visionError('invalid_request', `${where}: ${why}`, status, root.detail);
  }
  if (status === 404) {
    return visionError(
      'route_not_found',
      `POST ${url} is not mounted. Add app.include_router(vision_router) in backend/main.py and restart the API.`,
      status,
    );
  }
  return visionError(
    `http_${status}`,
    `POST ${url} failed with ${status} and no readable body: ${body.slice(0, 160) || '(empty)'}. If this is a vision failure, backend/main.py is missing register_error_handlers(app).`,
    status,
  );
}

async function postVision(path: string, payload: unknown, options: VisionFetchOptions): Promise<unknown> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}${path}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // addEventListener('abort') never fires on a signal that is ALREADY aborted, so without this
  // check a reset()/unmount during the encode step would still fire off a 30s model call.
  if (options.signal?.aborted) {
    throw visionError('aborted', 'The request was superseded or the component unmounted.');
  }
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
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw visionError('timeout', `${url} did not answer within ${timeoutMs}ms. Raise timeoutMs, or send a smaller image.`);
      }
      if (options.signal?.aborted) {
        throw visionError('aborted', 'The request was superseded or the component unmounted.');
      }
      const why = cause instanceof Error ? cause.message : String(cause);
      throw visionError('network_error', `${url} never reached the backend (${why}). Start it with \`make dev\` — the Vite proxy forwards /api to it.`);
    }
    const raw = await response.text();
    if (!response.ok) throw errorFromBody(response.status, raw, url);
    if (!raw) throw visionError('empty_response', `${url} returned ${response.status} with an empty body.`, response.status);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw visionError('bad_response', `${url} returned a body that is not JSON: ${raw.slice(0, 160)}`, response.status);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

const imagePayload = (image: VisionImage) => ({ media_type: image.mediaType, data: image.base64 });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function shapeError(path: string, what: string, body: unknown): VisionError {
  return visionError('bad_response', `${path} returned an unexpected shape: ${what}.`, 200, body);
}

export async function requestExtract<T>(
  images: VisionImage[],
  request: { schemaName: string; prompt?: string; system?: string },
  options: VisionFetchOptions = {},
): Promise<ExtractResult<T>> {
  const body = await postVision(
    '/extract',
    {
      schema_name: request.schemaName,
      images: images.map(imagePayload),
      prompt: request.prompt ?? null,
      system: request.system ?? null,
    },
    options,
  );
  const root = record(body);
  const result = root ? record(root.result) : null;
  const model = root && text(root.model);
  const elapsed = root && num(root.elapsed_ms);
  const schemaName = root && text(root.schema_name);
  if (!root || !result) throw shapeError('/extract', 'no `result` object', body);
  if (!model || elapsed === null || !schemaName) {
    throw shapeError('/extract', 'no `schema_name` / `model` / `elapsed_ms`', body);
  }
  return { result: result as T, schemaName, model, elapsedMs: elapsed };
}

export async function requestDetect(
  image: VisionImage,
  request: { labels?: string[]; prompt?: string; maxDetections?: number } = {},
  options: VisionFetchOptions = {},
): Promise<DetectResult> {
  const body = await postVision(
    '/detect',
    {
      image: imagePayload(image),
      labels: request.labels ?? [],
      prompt: request.prompt ?? null,
      max_detections: request.maxDetections ?? 12,
    },
    options,
  );
  const root = record(body);
  if (!root || !Array.isArray(root.regions)) throw shapeError('/detect', 'no `regions` array', body);
  const regions = root.regions.map((entry) => {
    const item = record(entry);
    const box = item ? record(item.box) : null;
    const label = item && text(item.label);
    const confidence = item && num(item.confidence);
    const x = box && num(box.x);
    const y = box && num(box.y);
    const width = box && num(box.width);
    const height = box && num(box.height);
    if (!label || confidence === null || x === null || y === null || width === null || height === null) {
      throw shapeError('/detect', 'a region missing its label, confidence, or four numeric box fields', entry);
    }
    return { label, confidence, box: { x, y, width, height } };
  });
  const dropped = Array.isArray(root.dropped)
    ? root.dropped.flatMap((entry) => {
        const item = record(entry);
        const label = item && text(item.label);
        const reason = item && text(item.reason);
        return label && reason ? [{ label, reason }] : [];
      })
    : [];
  const model = text(root.model);
  const elapsed = num(root.elapsed_ms);
  if (!model || elapsed === null) throw shapeError('/detect', 'no `model` / `elapsed_ms`', body);
  return { regions, dropped, model, elapsedMs: elapsed };
}
