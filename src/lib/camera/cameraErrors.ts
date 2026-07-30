// cameraErrors.ts — the named failure model for getUserMedia. No React, no DOM writes.
// COPY: into src/camera/ next to useCameraPhoto.ts. Zero dependencies.
// CHANGE: the `hint` strings so they match your product's wording.

export type CameraErrorKind =
  | 'insecure-context' // http:// on a phone — getUserMedia is not exposed at all
  | 'unsupported-browser' // no mediaDevices API (old WebView, in-app browser)
  | 'permission-denied' // user (or OS/policy/iframe) said no
  | 'no-camera' // device has no video input
  | 'camera-busy' // another app/tab holds the camera (Windows/Android)
  | 'overconstrained' // requested facingMode/resolution impossible
  | 'playback-blocked' // stream OK but <video>.play() rejected (autoplay policy)
  | 'stream-ended' // camera yanked mid-session (unplugged, OS revoked)
  | 'capture-failed' // canvas/encode step failed
  | 'unknown';

export interface CameraError {
  kind: CameraErrorKind;
  /** One short line for the UI headline. */
  message: string;
  /** One short line telling the user what to actually do. */
  hint: string;
  /** true => a Retry button makes sense. */
  recoverable: boolean;
  cause?: unknown;
}

/**
 * A real Error subclass, so `throw`n camera failures still satisfy
 * `e instanceof Error` and print a usable stack in the console.
 */
export class CameraFailure extends Error implements CameraError {
  readonly kind: CameraErrorKind;
  readonly hint: string;
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(kind: CameraErrorKind, message: string, hint: string, recoverable: boolean, cause?: unknown) {
    super(message);
    this.name = 'CameraFailure';
    this.kind = kind;
    this.hint = hint;
    this.recoverable = recoverable;
    this.cause = cause;
  }
}

export function camErr(
  kind: CameraErrorKind,
  message: string,
  hint: string,
  recoverable: boolean,
  cause?: unknown,
): CameraFailure {
  return new CameraFailure(kind, message, hint, recoverable, cause);
}

/** Distinct, actionable errors — never a single generic catch. */
export function classifyCameraError(cause: unknown): CameraFailure {
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause ? String((cause as DOMException).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return camErr(
        'permission-denied',
        'Camera permission denied',
        'Allow camera in the address bar / site settings. If this page is inside an iframe, it needs allow="camera".',
        true,
        cause,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return camErr('no-camera', 'No camera found', 'This device has no usable video input. Use the upload fallback instead.', false, cause);
    case 'NotReadableError':
    case 'TrackStartError':
      return camErr('camera-busy', 'Camera is in use', 'Close other apps or tabs using the camera (Zoom, FaceTime, another tab), then retry.', true, cause);
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return camErr('overconstrained', 'Camera cannot match the request', 'That camera/resolution is unavailable. Retry drops the constraints and takes any camera.', true, cause);
    case 'AbortError':
      return camErr('unknown', 'Camera start was aborted', 'Something interrupted the camera. Retry.', true, cause);
    default:
      return camErr(
        'unknown',
        'Camera failed to start',
        cause instanceof Error ? cause.message : 'Unknown media error. Retry, or use the upload fallback.',
        true,
        cause,
      );
  }
}

/** Support is checked BEFORE any call so http:// gets its own message, not "unknown". */
export function detectCameraSupport(): { supported: boolean; error: CameraFailure | null } {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, error: camErr('unsupported-browser', 'No browser environment', 'Camera capture only runs in a browser.', false) };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      error: camErr('insecure-context', 'Camera needs HTTPS', 'Open this page over https:// (or on localhost). See README for HTTPS on the LAN.', false),
    };
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return {
      supported: false,
      error: camErr('unsupported-browser', 'Camera not supported here', 'This browser blocks getUserMedia. Open in Safari/Chrome directly, or upload a photo.', false),
    };
  }
  return { supported: true, error: null };
}
