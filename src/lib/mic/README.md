# input-mic — voice input that degrades instead of dying

Self-contained pieces. Take one, take all of them.

| File | What it gives you | Needs |
| --- | --- | --- |
| `useSpeechRecognition.ts` | Live browser transcription (Web Speech API), continuous + interim results, auto-restart | nothing |
| `useAudioRecorder.ts` | `MediaRecorder` → audio `Blob` for server-side transcription | `audioMime.ts` |
| `audioMime.ts` | Container negotiation + the file extension transcription APIs dispatch on | nothing |
| `useMicLevel.ts` | Real `AnalyserNode` RMS level, 0..1 | nothing |
| `MicButton.tsx` + `mic.css` | Push-to-talk button, level meter, idle/listening/busy/error/unsupported states | `useMicLevel.ts`, `mic.css` |

Copy-paste rule: `MicButton.tsx` imports `./useMicLevel` and `./mic.css`; `useAudioRecorder.ts`
imports `./audioMime`. Keep those next to each other and nothing else is required — no npm
installs beyond React.

**Why this is a Technical Execution signal:** the Web Speech API is a rarely-used browser
capability — streaming interim transcripts with zero network round-trip and zero dependencies.
Pairing it with a `MediaRecorder` fallback and a live `AnalyserNode` meter is three distinct
browser audio APIs cooperating. Say that out loud in your demo.

## Browser support matrix

| Browser | `SpeechRecognition` | `MediaRecorder` | Recommended path |
| --- | --- | --- | --- |
| Chrome / Edge desktop | ✅ `webkitSpeechRecognition` | ✅ `audio/webm;codecs=opus` | Web Speech |
| Chrome Android | ✅ | ✅ webm/opus | Web Speech |
| Safari 14.1+ (macOS/iOS) | ⚠️ present but gesture-gated, `continuous` unreliable | ✅ `audio/mp4` (AAC) | Recorder → server |
| Firefox | ❌ absent | ✅ `audio/ogg`/`audio/webm` | Recorder → server |
| Any browser over plain HTTP | ❌ blocked | ❌ blocked | Typing fallback |

Both hooks detect this for you and return `{ supported, unsupportedReason }`. **`unsupportedReason`
is a user-facing string — pass it to `MicButton` as `unsupportedHint`.** `MicButton` refuses to
render a dead button: when `supported === false` it renders that reason plus your `fallback`
(a textarea). Forget the `fallback` and it renders a red alert saying so, instead of a dead end.

## Permission gotchas (symptom → fix)

1. **Secure context required.** Symptom: both APIs no-op on `http://192.168.1.5:5173` while
   working on your laptop. Fix: demo from `localhost`, or `vite --host` behind an HTTPS tunnel
   (`cloudflared tunnel --url http://localhost:5173`). `unsupportedReason` says this explicitly.
2. **Chrome stops `continuous` recognition after ~5s of silence.** Symptom: `listening` stays true
   but words stop appearing. Fix: already handled — `useSpeechRecognition` restarts from `onend`
   while `wantListening` is true, with a 600 ms floor and a `FATAL_CODES` guard so a dead engine
   cannot loop. If you rewrite this hook, keep both guards.
3. **`no-speech` / `aborted` are lifecycle noise.** Symptom: an error banner flashes every few
   seconds during normal use. Fix: swallow those two codes only. `not-allowed`,
   `service-not-allowed`, `audio-capture`, `network`, `language-not-supported` are fatal — stop
   listening and show `error`.
4. **Denied permission is sticky per origin.** Symptom: your retry button appears to do nothing,
   because `getUserMedia` rejects instantly forever. Fix: the error copy tells the user to change
   it in site settings (Chrome: the icon left of the URL → Microphone → Allow → reload). A retry
   button alone reads as a broken app.
5. **`AudioContext` starts suspended outside a user gesture.** Symptom: meter frozen at 0 while
   audio records fine. Fix: `useMicLevel` calls `ctx.resume()` and re-checks its cancel flag
   afterwards; start recording from a real click, not from a `useEffect` on mount.
6. **One stream, one prompt.** Symptom: two permission prompts, or the mic light stays on after
   stopping. Fix: pass `useAudioRecorder().stream` into `MicButton`'s `stream` prop — the meter
   then reuses the open stream and stops only tracks it opened itself.
7. **Safari gives you the audio in `onstop`, not in chunks.** Fix: `stop()` returns a promise that
   resolves with the assembled `Blob`, so you can `await rec.stop()` and upload in one line.
8. **Wrong file extension = rejected upload.** Symptom: Safari's mp4 clip 400s from Whisper.
   Fix: upload as `clip.${clip.extension}` — `extensionFor()` derives it from the negotiated
   container (`m4a` on Safari, `webm` on Chrome). Never hardcode `.webm`.
9. **The 120 s cap stops the recorder for you.** Symptom (if you re-implement it): a later `stop()`
   returns null and you show "nothing recorded" over a perfectly good clip. Fix: `stop()` returns
   `lastRef` when the recorder is already inactive.

## Usage — Web Speech with a typing fallback

```tsx
const [text, setText] = useState('');
const speech = useSpeechRecognition({ lang: 'en-US', onFinal: (utterance) => send(utterance) });

return (
  <MicButton
    supported={speech.supported}
    listening={speech.listening}
    error={speech.error}
    unsupportedHint={speech.unsupportedReason}
    onStart={speech.start}
    onStop={speech.stop}
    fallback={<textarea value={text} onChange={(e) => setText(e.target.value)} />}
  />
);
```

Render `speech.transcript` solid and `speech.interim` at 50% opacity for the streaming effect.
`onFinal` fires exactly once per utterance — it is deliberately called outside the `setState`
updater, because React StrictMode double-invokes updaters in dev and would double-send.

## Usage — recorder fallback (Safari/Firefox)

```tsx
const rec = useAudioRecorder();
const [text, setText] = useState('');
const [busy, setBusy] = useState(false);
const [err, setErr] = useState<string | null>(null);

async function finish() {
  const clip = await rec.stop();            // null when nothing usable was captured
  if (!clip) { setErr('Nothing was recorded — try again.'); return; }
  setBusy(true); setErr(null);
  try {
    const body = new FormData();
    body.append('audio', clip.blob, `clip.${clip.extension}`);
    const res = await fetch('/api/transcribe', { method: 'POST', body });
    if (!res.ok) throw new Error((await res.text()) || `Transcription failed (${res.status})`);
    const data = (await res.json()) as { text: string };
    setText(data.text);
  } catch (e) {
    setErr(e instanceof Error ? e.message : 'Transcription failed.');
  } finally { setBusy(false); }
}

<MicButton supported={rec.supported} listening={rec.recording} busy={busy || rec.busy}
  error={err ?? rec.error} unsupportedHint={rec.unsupportedReason} stream={rec.stream}
  onStart={() => void rec.start()} onStop={() => void finish()}
  fallback={<textarea value={text} onChange={(e) => setText(e.target.value)} />} />
```

## Matching FastAPI endpoint — fails loudly, never fakes

Anthropic has no speech-to-text endpoint, so this one route uses OpenAI Whisper. Everything
else in your app can stay on `claude-sonnet-5`. `pip install openai python-multipart`.

```python
import os

from fastapi import APIRouter, File, HTTPException, UploadFile
from openai import AsyncOpenAI
from pydantic import BaseModel

router = APIRouter()

# Fail at import time, not at 19:15 with a fake transcript on screen.
_KEY = os.environ.get("OPENAI_API_KEY")
if not _KEY:
    raise RuntimeError("OPENAI_API_KEY is not set — /api/transcribe cannot work without it.")
_client = AsyncOpenAI(api_key=_KEY)

MAX_BYTES = 25 * 1024 * 1024  # OpenAI's hard upload limit


class Transcript(BaseModel):
    text: str


@router.post("/api/transcribe", response_model=Transcript)
async def transcribe(audio: UploadFile = File(...)) -> Transcript:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Clip is larger than the 25 MB limit.")

    # The extension is what the API dispatches on — keep the one the browser negotiated.
    filename = audio.filename or "clip.webm"
    try:
        result = await _client.audio.transcriptions.create(
            model="whisper-1",
            file=(filename, data, audio.content_type or "application/octet-stream"),
        )
    except Exception as exc:  # surface it — do NOT return placeholder text
        raise HTTPException(status_code=502, detail=f"Transcription provider failed: {exc}") from exc

    text = (result.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="No speech found in the audio.")
    return Transcript(text=text)
```

Note the async client: the sync one blocks the event loop for the whole upload, which freezes
every other request during your demo.

## State checklist this module already satisfies

- **Loading** — `busy` on `MicButton` (spinner + disabled); `state: 'requesting' | 'stopping'`
  on the recorder, exposed as `busy`.
- **Error** — every async path sets a human-readable string; rendered with `role="alert"`.
  No path returns empty or default data on failure.
- **Empty** — zero-byte blob is an error, not a result; silence (`level < 0.02`) is called out
  live; the endpoint 422s on an empty transcript instead of returning `""`.
- **Unsupported** — `unsupportedReason` + a `fallback` typing path, enforced by the component.

## API

`useSpeechRecognition(opts)` → `{ supported, unsupportedReason, listening, transcript, interim, error, errorCode, start, stop, reset }`

`useAudioRecorder(opts)` → `{ supported, unsupportedReason, state, recording, busy, error, stream, last, start, stop, reset }`
— `stop()` resolves `{ blob, mimeType, extension, durationMs, size } | null`.

`useMicLevel(active, stream?)` → `{ level /* 0..1 RMS */, meterError }` — also re-exported from
`MicButton.tsx` if you want the meter somewhere else.

`pickMimeType()` → `string | null` (`''` means "browser default"). `extensionFor(mime)` → `'webm' | 'm4a' | …`
