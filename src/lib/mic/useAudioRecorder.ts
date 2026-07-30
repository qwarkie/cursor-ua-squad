// useAudioRecorder.ts — MediaRecorder capture -> audio Blob, for server-side transcription (Whisper etc.).
// COPY: drop into src/hooks/ TOGETHER WITH audioMime.ts; the fallback when useSpeechRecognition().supported === false.
// CHANGE: `maxMs` (default 120s) and audioConstraints; container order lives in audioMime.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { extensionFor, pickMimeType } from './audioMime';

export { extensionFor, pickMimeType };

export interface Recording {
  blob: Blob;
  mimeType: string;
  /** e.g. "webm" — append to your upload filename. */
  extension: string;
  durationMs: number;
  size: number;
}

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error';

export interface UseAudioRecorderResult {
  supported: boolean;
  unsupportedReason: string | null;
  /** Drive your button off this: 'requesting' and 'stopping' are the loading states. */
  state: RecorderState;
  recording: boolean;
  busy: boolean;
  error: string | null;
  /** Live stream while recording — feed it to the level meter so you only prompt once. */
  stream: MediaStream | null;
  last: Recording | null;
  start: () => Promise<void>;
  /** Resolves with the capture, or null when nothing usable was recorded (branch on it). */
  stop: () => Promise<Recording | null>;
  reset: () => void;
}

export interface UseAudioRecorderOptions {
  maxMs?: number;
  /** Passed to getUserMedia; defaults enable browser noise suppression. */
  audioConstraints?: MediaTrackConstraints;
}

function detectUnsupported(): string | null {
  if (typeof window === 'undefined') return 'Not running in a browser.';
  if (!window.isSecureContext) return 'Microphone capture requires HTTPS (localhost is fine).';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot access the microphone (getUserMedia missing).';
  if (typeof MediaRecorder === 'undefined') return 'This browser has no MediaRecorder. Type your input instead.';
  if (pickMimeType() === null) return 'No audio container this browser can record is supported.';
  return null;
}

export function useAudioRecorder(options: UseAudioRecorderOptions = {}): UseAudioRecorderResult {
  const { maxMs = 120_000, audioConstraints } = options;

  const [unsupportedReason] = useState<string | null>(detectUnsupported);
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [last, setLast] = useState<Recording | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const resolveRef = useRef<((r: Recording | null) => void) | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  /** Synchronous re-entry guard — `state` is a render-old snapshot inside a double click. */
  const activeRef = useRef(false);
  /** Mirrors `last` so stop() can still hand back a clip the maxMs timer already finished. */
  const lastRef = useRef<Recording | null>(null);
  /** Set when stop() lands while the permission prompt is still open — see the check after await. */
  const abortRef = useRef(false);

  const supported = unsupportedReason === null;

  const teardown = useCallback(() => {
    if (maxTimerRef.current !== null) { window.clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    recorderRef.current = null;
    activeRef.current = false;
    setStream(null); // the [stream] effect below stops the tracks — one owner, no double-stop logic
  }, []);

  const start = useCallback(async () => {
    if (!supported) { setError(unsupportedReason); setState('error'); return; }
    if (activeRef.current) return;
    activeRef.current = true;
    abortRef.current = false;
    lastRef.current = null;
    setError(null);
    setLast(null);
    setState('requesting');

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : 'Error';
      setError(
        name === 'NotAllowedError' ? 'Microphone permission denied. Allow it in site settings and try again.'
        : name === 'NotFoundError' ? 'No microphone found. Connect one and try again.'
        : name === 'NotReadableError' ? 'The microphone is already in use by another app.'
        : name === 'OverconstrainedError' ? 'No input device matches the requested audio constraints.'
        : `Could not open the microphone (${name}).`,
      );
      activeRef.current = false;
      setState('error');
      return;
    }

    // The user released the button (or unmounted) while the permission prompt was open.
    // Without this the granted stream would stay hot forever with the tab's mic light on.
    if (abortRef.current) {
      media.getTracks().forEach((t) => t.stop());
      abortRef.current = false; activeRef.current = false;
      setState('idle');
      return;
    }

    const mimeType = pickMimeType() ?? '';
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(media, { mimeType }) : new MediaRecorder(media);
    } catch {
      media.getTracks().forEach((t) => t.stop());
      setError('This browser refused every audio format we can record.');
      activeRef.current = false;
      setState('error');
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = () => { setError('Recording failed mid-capture.'); setState('error'); teardown(); resolveRef.current?.(null); resolveRef.current = null; };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      teardown();
      if (blob.size === 0) {
        setError('No audio was captured — the microphone produced an empty stream.');
        setState('error');
        resolveRef.current?.(null);
      } else {
        const result: Recording = {
          blob, mimeType: type, extension: extensionFor(type),
          durationMs: Date.now() - startedAtRef.current, size: blob.size,
        };
        lastRef.current = result;
        setLast(result);
        setState('idle');
        resolveRef.current?.(result);
      }
      resolveRef.current = null;
    };

    recorderRef.current = recorder;
    setStream(media);
    startedAtRef.current = Date.now();
    recorder.start(250); // timeslice keeps chunks flowing so a crash still leaves partial audio
    setState('recording');
    maxTimerRef.current = window.setTimeout(() => {
      if (recorderRef.current?.state === 'recording') { setState('stopping'); recorderRef.current.stop(); }
    }, maxMs);
  }, [supported, unsupportedReason, audioConstraints, maxMs, teardown]);

  const stop = useCallback((): Promise<Recording | null> => {
    const recorder = recorderRef.current;
    // Already inactive means the maxMs cap fired and onstop finished the clip without us —
    // hand back that clip instead of a null the caller would report as "nothing recorded".
    if (!recorder || recorder.state === 'inactive') {
      if (activeRef.current) abortRef.current = true; // getUserMedia is still pending — cancel it
      teardown();
      return Promise.resolve(lastRef.current);
    }
    setState('stopping');
    return new Promise<Recording | null>((resolve) => { resolveRef.current = resolve; recorder.stop(); });
  }, [teardown]);

  const reset = useCallback(() => {
    lastRef.current = null;
    setLast(null); setError(null); setState((s) => (s === 'error' ? 'idle' : s));
  }, []);

  useEffect(() => () => {
    abortRef.current = true; // kills a getUserMedia that resolves after unmount
    try { if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop(); } catch { /* noop */ }
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current);
  }, []);
  useEffect(() => () => { stream?.getTracks().forEach((t) => t.stop()); }, [stream]);

  return {
    supported, unsupportedReason, state, recording: state === 'recording',
    busy: state === 'requesting' || state === 'stopping',
    error, stream, last, start, stop, reset,
  };
}
