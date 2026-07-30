// visionTypes.ts — every shape a caller of this module sees: the state union, the typed error, the box.
// COPY: with the rest of kit/vision into src/lib/vision/. Import from '@/lib/vision/visionTypes'.
// CHANGE: nothing here. Extend DetectedRegion only together with detect.py, or the two drift apart.

export type VisionMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

/** An image already encoded for the wire. `input-camera-photo`'s `EncodedImage` satisfies this. */
export interface VisionImage {
  /** Raw base64 — no `data:` prefix, no newlines. */
  base64: string;
  mediaType: VisionMediaType;
  /** Intrinsic pixels of the encoded bytes. Boxes are fractions, so this is informational. */
  width: number;
  height: number;
}

/** The backend's `{code, message}` envelope. `status === null` means the request never landed. */
export interface VisionError {
  code: string;
  message: string;
  status: number | null;
  detail?: unknown;
}

/** Fractions of the image, origin top-left, all in [0..1]. Resolution-independent by design. */
export interface NormalisedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedRegion {
  label: string;
  /** 0..1 as reported by the model. Not calibrated — render it, do not threshold silently. */
  confidence: number;
  box: NormalisedBox;
}

/** A region the model returned that had no usable box. Reported, never quietly discarded. */
export interface DroppedRegion {
  label: string;
  reason: string;
}

export interface DetectResult {
  regions: DetectedRegion[];
  dropped: DroppedRegion[];
  model: string;
  elapsedMs: number;
}

export interface ExtractResult<T> {
  result: T;
  schemaName: string;
  model: string;
  elapsedMs: number;
}

/** Forget a branch and TypeScript refuses to compile. Same discipline as kit/ui-states. */
export type VisionState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: VisionError }
  | { status: 'unsupported'; capability: string; reason: string; hint: string };

export const visionError = (
  code: string,
  message: string,
  status: number | null = null,
  detail?: unknown,
): VisionError => ({ code, message, status, detail });

export function isVisionError(value: unknown): value is VisionError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VisionError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/** Any thrown value -> the typed error. A VisionError passes through untouched. */
export function toVisionError(thrown: unknown): VisionError {
  if (isVisionError(thrown)) return thrown;
  return visionError('unexpected_error', thrown instanceof Error ? thrown.message : String(thrown));
}

export function isVisionImage(value: unknown): value is VisionImage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VisionImage>;
  return typeof candidate.base64 === 'string' && typeof candidate.mediaType === 'string';
}

/** What the `unsupported` branch is handed. One object, never three positional strings. */
export interface VisionUnsupported {
  capability: string;
  reason: string;
  hint: string;
}

/**
 * Exhaustive `switch` as an expression — omit a handler and the build fails.
 * `unsupported` takes ONE object: kit/ui-states' `match` passes `(capability, hint)` positionally,
 * and a two-argument lambda copied from there would otherwise bind `hint` to the reason silently.
 * Against a one-parameter signature TypeScript rejects it outright, which is the point.
 */
export function matchVision<T, R>(
  state: VisionState<T>,
  handlers: {
    idle: () => R;
    loading: () => R;
    ready: (data: T) => R;
    error: (error: VisionError) => R;
    unsupported: (info: VisionUnsupported) => R;
  },
): R {
  switch (state.status) {
    case 'idle':
      return handlers.idle();
    case 'loading':
      return handlers.loading();
    case 'ready':
      return handlers.ready(state.data);
    case 'error':
      return handlers.error(state.error);
    case 'unsupported':
      return handlers.unsupported({
        capability: state.capability,
        reason: state.reason,
        hint: state.hint,
      });
    default: {
      const never: never = state;
      throw new Error(`Unhandled vision state: ${JSON.stringify(never)}`);
    }
  }
}
