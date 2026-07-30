// Voice input: tap to start, tap again to stop and transcribe. A toggle rather than
// press-and-hold, because holding a button while reading numbers off a bank app is awkward
// on a phone and impossible to do accessibly with a keyboard.
//
// The clip goes to the backend, which forwards it to Groq Whisper, so the key never reaches
// the browser.
//
// Every failure has its own message: no HTTPS, permission denied, no key configured, a clip
// with no speech in it. The text field keeps working through all of them, which is why the
// mic is allowed to fail visibly instead of being hidden.

import { Microphone01, MicrophoneOff01 } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { useAudioRecorder } from '@/lib/mic/useAudioRecorder';
import { useMicLevel } from '@/lib/mic/useMicLevel';
import { fetchJson, useAsync } from '@/lib/ui-states/useAsync';

interface Transcript {
  text: string;
  model: string;
  bytes_sent: number;
}

interface VoiceStatus {
  configured: boolean;
  model: string;
  reason: string;
}

export interface MicButtonProps {
  /** Called with the transcribed text. The parent decides whether to send or let the user edit. */
  onTranscript: (text: string) => void;
  /** True while the parent is busy; recording is refused rather than queued. */
  disabled?: boolean;
}

export function MicButton({ onTranscript, disabled = false }: MicButtonProps) {
  const recorder = useAudioRecorder({ maxMs: 60_000 });
  const { level } = useMicLevel(recorder.recording, recorder.stream);
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  // Ask once whether voice is configured at all, so the button can say why it is off
  // before the user presses it and gets a 503 in the face.
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<VoiceStatus>('/api/voice/status', { signal: controller.signal })
      .then(setStatus)
      .catch(() => setStatus({ configured: false, model: '', reason: 'Voice service unreachable.' }));
    return () => controller.abort();
  }, []);

  const transcribe = useAsync<Transcript, [Blob, string]>((signal, blob, extension) => {
    const body = new FormData();
    // No Content-Type header: the browser must set the multipart boundary itself.
    body.append('clip', blob, `clip.${extension}`);
    return fetchJson<Transcript>('/api/voice/transcribe', { method: 'POST', body, signal, timeoutMs: 60_000 });
  });

  const stop = async () => {
    const clip = await recorder.stop();
    if (!clip) return; // nothing usable was captured; the recorder's own error is rendered
    const committed = await transcribe.run(clip.blob, clip.extension);
    if (committed.status === 'success' && committed.data.text) onTranscript(committed.data.text);
  };

  const busy = recorder.busy || transcribe.state.status === 'loading';
  const off = !recorder.supported || status?.configured === false;
  const reason =
    recorder.unsupportedReason ??
    (status?.configured === false ? status.reason : null) ??
    recorder.error ??
    (transcribe.state.status === 'error' ? transcribe.state.error.message : null);

  const label = recorder.recording
    ? 'Stop recording and transcribe'
    : off
      ? `Voice input unavailable. ${reason ?? ''}`
      : 'Record your answer';

  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={off || disabled || busy}
        onClick={() => (recorder.recording ? void stop() : void recorder.start())}
        className={[
          'relative grid size-11 shrink-0 place-items-center rounded-full transition',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          'active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40',
          recorder.recording
            ? 'bg-error-solid text-white'
            : 'border border-secondary bg-primary text-fg-quaternary hover:bg-primary_hover hover:text-fg-secondary',
        ].join(' ')}
      >
        {/* The ring tracks real input level, so a dead microphone is visible before the
            user finishes a sentence and finds out the hard way. */}
        {recorder.recording && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-error-solid/40"
            style={{ transform: `scale(${1 + Math.min(level, 1) * 0.35})` }}
          />
        )}
        {off ? <MicrophoneOff01 className="size-5" /> : <Microphone01 className="size-5" />}
      </button>

      {(recorder.recording || busy || reason) && (
        <p
          role="status"
          className={[
            'absolute -top-7 whitespace-nowrap rounded-md px-2 py-1 text-xs',
            reason && !recorder.recording ? 'bg-error-primary text-error-primary' : 'bg-secondary text-tertiary',
          ].join(' ')}
        >
          {transcribe.state.status === 'loading'
            ? 'Transcribing'
            : recorder.recording
              ? 'Listening, tap to stop'
              : recorder.state === 'requesting'
                ? 'Waiting for the mic'
                : reason}
        </p>
      )}
    </div>
  );
}
