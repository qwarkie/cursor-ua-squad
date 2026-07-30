// useCameraPhoto.ts — React hook around getUserMedia for rear-camera stills.
// COPY: this file + cameraErrors.ts into src/camera/ (no deps beyond react).
// CHANGE: the defaults in UseCameraPhotoOptions (facingMode / idealWidth / imageType).

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { camErr, classifyCameraError, detectCameraSupport, type CameraError } from './cameraErrors';

// Re-exported so consumers only ever import from this file.
export { CameraFailure } from './cameraErrors';
export type { CameraError, CameraErrorKind } from './cameraErrors';

export type CameraStatus = 'idle' | 'starting' | 'ready' | 'error';

export interface UseCameraPhotoOptions {
  autoStart?: boolean;
  facingMode?: 'environment' | 'user';
  /** Ideal long-edge in px asked of the sensor. Capture is still full-res. */
  idealWidth?: number;
  imageType?: 'image/jpeg' | 'image/png';
  imageQuality?: number;
}

export interface UseCameraPhoto {
  supported: boolean;
  ready: boolean;
  status: CameraStatus;
  starting: boolean;
  capturing: boolean;
  error: CameraError | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  start: () => void;
  stop: () => void;
  /** Recovers the right way per error kind: replay, relax constraints, or re-acquire. */
  retry: () => void;
  capture: () => Promise<Blob>;
}

export function useCameraPhoto(options: UseCameraPhotoOptions = {}): UseCameraPhoto {
  const {
    autoStart = true,
    facingMode = 'environment',
    idealWidth = 1920,
    imageType = 'image/jpeg',
    imageQuality = 0.92,
  } = options;

  const support = useMemo(detectCameraSupport, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(autoStart && support.supported);
  const [attempt, setAttempt] = useState(0);
  const [playAttempt, setPlayAttempt] = useState(0);
  // Set once an OverconstrainedError proves the ideal constraints are impossible.
  const [relaxed, setRelaxed] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>(support.supported ? 'idle' : 'error');
  const [error, setError] = useState<CameraError | null>(support.error);
  const [capturing, setCapturing] = useState(false);

  // 1. Acquire the stream. Cancellation token guards React 19 StrictMode double-run.
  useEffect(() => {
    if (!active || !support.supported) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    setStatus('starting');
    setError(null);
    const constraints: MediaStreamConstraints = {
      audio: false,
      // `ideal` (not `exact`) so laptops without a rear camera still work;
      // `true` once we know the ideal set was rejected outright.
      video: relaxed ? true : { facingMode: { ideal: facingMode }, width: { ideal: idealWidth } },
    };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((s) => {
        acquired = s;
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        setStream(s);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(classifyCameraError(cause));
        setStatus('error');
      });
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [active, attempt, relaxed, support.supported, facingMode, idealWidth]);

  // 2. Bind stream -> <video>, and surface playback + mid-session death as real errors.
  useEffect(() => {
    const video = videoRef.current;
    if (!stream || !video) return;
    let cancelled = false;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    const onReady = () => { if (!cancelled) setStatus('ready'); };
    video.addEventListener('loadedmetadata', onReady);
    // Re-binding the same stream never re-fires loadedmetadata — read the state directly.
    if (video.readyState >= 1 && video.videoWidth > 0) onReady();
    void video.play().catch((cause: unknown) => {
      if (cancelled) return;
      setError(camErr('playback-blocked', 'Preview blocked by the browser', 'Autoplay needs a tap — press "Start preview" to begin the live view.', true, cause));
      setStatus('error');
    });
    const track = stream.getVideoTracks()[0];
    const onEnded = () => {
      if (cancelled) return;
      setError(camErr('stream-ended', 'Camera disconnected', 'The camera stopped (unplugged, or another app took it). Retry to reconnect.', true));
      setStatus('error');
    };
    track?.addEventListener('ended', onEnded);
    return () => {
      cancelled = true;
      video.removeEventListener('loadedmetadata', onReady);
      track?.removeEventListener('ended', onEnded);
      video.srcObject = null;
    };
  }, [stream, playAttempt]);

  const start = useCallback(() => { if (support.supported) setActive(true); }, [support.supported]);

  const stop = useCallback(() => {
    setActive(false);
    // Never clear a hard support error — the fallback UI depends on it staying visible.
    if (support.supported) { setStatus('idle'); setError(null); }
  }, [support.supported]);

  const retry = useCallback(() => {
    if (!support.supported) return; // insecure-context / no API is NOT retryable
    // Autoplay was blocked but the stream is alive: replay it, don't re-prompt for permission.
    if (error?.kind === 'playback-blocked' && stream) {
      setError(null);
      setStatus('starting');
      setPlayAttempt((n) => n + 1);
      return;
    }
    if (error?.kind === 'overconstrained') setRelaxed(true);
    setError(null);
    setActive(true);
    setAttempt((n) => n + 1);
  }, [support.supported, error, stream]);

  const capture = useCallback(async (): Promise<Blob> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      throw camErr('capture-failed', 'Preview not ready', 'Wait for the live preview before taking a shot.', true);
    }
    setCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw camErr('capture-failed', 'Canvas unavailable', 'This browser refused a 2D canvas context. Use the upload fallback.', false);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, imageType, imageQuality));
      if (!blob || blob.size === 0) {
        throw camErr('capture-failed', 'Could not encode the photo', 'The frame came back empty. Retry the shot.', true);
      }
      return blob;
    } finally {
      setCapturing(false);
    }
  }, [imageType, imageQuality]);

  return {
    supported: support.supported,
    ready: status === 'ready',
    status,
    starting: status === 'starting',
    capturing,
    error,
    videoRef,
    start,
    stop,
    retry,
    capture,
  };
}
