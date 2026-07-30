// CameraCapture.tsx — fullscreen rear-camera preview + shutter + thumbnail strip.
// COPY: with useCameraPhoto.ts, cameraErrors.ts, toBase64.ts and camera.css into src/camera/.
// CHANGE: maxShots, the header title, and what onDone(shots) hands to your API call.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useCameraPhoto } from './useCameraPhoto';
import { readImageSize } from './toBase64';
import './camera.css';

export interface Shot {
  id: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  takenAt: number;
}

export interface CameraCaptureProps {
  maxShots?: number;
  /** Fires on every add/remove — keep your parent state in sync here. */
  onShotsChange?: (shots: Shot[]) => void;
  /** Fires when the user taps the primary action. Rejections are caught and shown. */
  onDone?: (shots: Shot[]) => void | Promise<void>;
  doneLabel?: string;
  title?: string;
  busy?: boolean;
}

const newId = () => `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const msgOf = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message
    : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message)
    : fallback;

export function CameraCapture({
  maxShots = 8,
  onShotsChange,
  onDone,
  doneLabel = 'Analyze',
  title = 'Point at the subject',
  busy = false,
}: CameraCaptureProps) {
  const cam = useCameraPhoto({ autoStart: true, facingMode: 'environment' });
  const [shots, setShots] = useState<Shot[]>([]);
  const [shotError, setShotError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;
  const changeRef = useRef(onShotsChange);
  changeRef.current = onShotsChange;

  // Revoke every preview URL on unmount so long sessions don't leak blobs.
  useEffect(() => () => { shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)); }, []);
  useEffect(() => { changeRef.current?.(shots); }, [shots]);

  const addBlob = useCallback(async (blob: Blob) => {
    if (shotsRef.current.length >= maxShots) throw new Error(`Limit reached — ${maxShots} photos max.`);
    const { width, height } = await readImageSize(blob); // throws on a corrupt / non-image blob
    const shot: Shot = { id: newId(), blob, url: URL.createObjectURL(blob), width, height, takenAt: Date.now() };
    shotsRef.current = [...shotsRef.current, shot]; // keep the guard accurate inside a loop
    setShots(shotsRef.current);
  }, [maxShots]);

  const onShutter = useCallback(async () => {
    setShotError(null);
    if (shotsRef.current.length >= maxShots) { setShotError(`Limit reached — ${maxShots} photos max. Remove one first.`); return; }
    try {
      await addBlob(await cam.capture());
    } catch (e) {
      setShotError(msgOf(e, 'Capture failed.'));
    }
  }, [addBlob, cam, maxShots]);

  const onPickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setShotError(null);
    const picked = Array.from(files);
    const room = Math.max(0, maxShots - shotsRef.current.length);
    if (room === 0) { setShotError(`Limit reached — ${maxShots} photos max. Remove one first.`); return; }
    const failed: string[] = [];
    for (const file of picked.slice(0, room)) {
      try {
        await addBlob(file);
      } catch (e) {
        failed.push(`${file.name}: ${msgOf(e, 'could not be read as an image')}`);
      }
    }
    // Never silently drop the overflow — say exactly how many were ignored.
    const dropped = picked.length - Math.min(picked.length, room);
    const notes = [...failed, ...(dropped > 0 ? [`${dropped} file(s) skipped — ${maxShots} photo limit.`] : [])];
    if (notes.length > 0) setShotError(notes.join(' '));
  }, [addBlob, maxShots]);

  const removeShot = useCallback((id: string) => {
    setShots((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  const submit = useCallback(async () => {
    if (!onDone || shots.length === 0) return;
    setShotError(null);
    setSubmitting(true);
    try {
      await onDone(shots);
    } catch (e) {
      setShotError(msgOf(e, 'Submission failed.')); // surfaced, never swallowed
    } finally {
      setSubmitting(false);
    }
  }, [onDone, shots]);

  const working = submitting || busy;
  const pick = (e: ChangeEvent<HTMLInputElement>) => { void onPickFiles(e.target.files); e.target.value = ''; };

  // Two inputs on purpose: `capture` forces the camera app AND disables `multiple`,
  // which is wrong when the camera is the thing that failed (no-camera / in-app browser).
  const fallback = (
    <>
      <label className="cam-fallback">
        <input type="file" accept="image/*" capture="environment" onChange={pick} />
        <span>Use the camera app</span>
      </label>
      <label className="cam-fallback">
        <input type="file" accept="image/*" multiple onChange={pick} />
        <span>Choose from library</span>
      </label>
    </>
  );

  return (
    <div className="cam-root">
      <div className="cam-stage">
        <video ref={cam.videoRef} className="cam-video" playsInline muted autoPlay />

        {cam.starting && (
          <div className="cam-overlay"><div className="cam-spinner" /><p>Starting camera…</p></div>
        )}

        {cam.status === 'error' && cam.error && (
          <div className="cam-overlay cam-overlay--error" role="alert">
            <p className="cam-err-title">{cam.error.message}</p>
            <p className="cam-err-hint">{cam.error.hint}</p>
            <p className="cam-err-code">{cam.error.kind}</p>
            <div className="cam-err-actions">
              {cam.error.recoverable && (
                <button type="button" className="cam-btn cam-btn--primary" onClick={cam.retry}>
                  {cam.error.kind === 'playback-blocked' ? 'Start preview' : 'Retry camera'}
                </button>
              )}
              {fallback}
            </div>
          </div>
        )}

        {cam.ready && <p className="cam-title">{title}</p>}
      </div>

      <div className="cam-bar">
        <span className="cam-count">{shots.length}/{maxShots}</span>
        <button
          type="button"
          className="cam-shutter"
          onClick={() => void onShutter()}
          disabled={!cam.ready || cam.capturing || shots.length >= maxShots || working}
          aria-label="Take photo"
        >
          <span className={cam.capturing ? 'cam-shutter-dot cam-shutter-dot--busy' : 'cam-shutter-dot'} />
        </button>
        <button type="button" className="cam-btn cam-btn--primary" onClick={() => void submit()} disabled={shots.length === 0 || working || !onDone}>
          {working ? <><span className="cam-spinner cam-spinner--sm" />Working…</> : `${doneLabel} (${shots.length})`}
        </button>
      </div>

      {shotError && <p className="cam-inline-error" role="alert">{shotError}</p>}

      <div className="cam-strip">
        {shots.length === 0 ? (
          <p className="cam-empty">No photos yet — tap the shutter to add one.</p>
        ) : (
          shots.map((s) => (
            <figure key={s.id} className="cam-thumb">
              <img src={s.url} alt={`Capture ${new Date(s.takenAt).toLocaleTimeString()}`} />
              <button type="button" className="cam-thumb-x" onClick={() => removeShot(s.id)} aria-label="Remove photo" disabled={working}>×</button>
              <figcaption>{s.width}×{s.height}</figcaption>
            </figure>
          ))
        )}
      </div>
    </div>
  );
}

export default CameraCapture;
