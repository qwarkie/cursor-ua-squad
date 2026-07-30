# input-camera-photo

Rear-camera stills in the browser: live preview, shutter, thumbnail strip, downscale + base64 for a vision model.

**COPY** the whole folder into `src/camera/`. **CHANGE** `onDone` in `CameraCapture` to call your backend.
No dependencies beyond React 19 + TypeScript.

```
cameraErrors.ts     the 10 named failure kinds + CameraFailure (a real Error subclass)
useCameraPhoto.ts   getUserMedia lifecycle, kind-aware retry, capture()
CameraCapture.tsx   preview + shutter + thumbnail strip + upload fallback
toBase64.ts         canvas downscale -> base64 (+ Anthropic / OpenAI image blocks)
camera.css          styles (imported by CameraCapture.tsx)
```

All five files. `CameraCapture.tsx` imports the other four; nothing outside the folder.

If `import './camera.css'` errors with *Cannot find module*, the repo has no CSS-module typing. `template/` already handles it via `"types": ["vite/client"]` in `tsconfig.json`; elsewhere add `src/vite-env.d.ts` — create it with
one line: `/// <reference types="vite/client" />`. (scaffold
already has it.) Typechecks clean under `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.

## Use it

```tsx
import { CameraCapture, type Shot } from './camera/CameraCapture';
import { toBase64, toAnthropicImageBlock } from './camera/toBase64';

async function analyze(shots: Shot[]) {
  const images = await Promise.all(shots.map((s) => toBase64(s.blob, { maxDimension: 1024 })));
  const res = await fetch('/api/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: images.map((i) => ({ media_type: i.mediaType, data: i.base64 })) }),
  });
  if (!res.ok) throw new Error(`Vision API failed: ${res.status} ${await res.text()}`); // surfaces in the red inline banner
  return res.json();
}

<CameraCapture maxShots={4} doneLabel="Identify" onDone={analyze} />
```

`onDone` may throw — `CameraCapture` catches it, stops the spinner, and shows the message. Never swallow it and never
substitute placeholder results.

## THE iPHONE GOTCHA — camera needs HTTPS

`navigator.mediaDevices` **does not exist** on `http://192.168.x.x`. On a phone the API is not "denied", it is simply
absent, so a naive `try/catch` reports a useless generic error. The hook checks `window.isSecureContext` *first* and
returns `kind: 'insecure-context'` with the real fix. Secure origins: `https://*`, `localhost`, `127.0.0.1`.
A LAN IP over http is **not** one.

### Fastest fix (30 seconds) — a tunnel

```bash
npm run dev -- --host                                # terminal 1
npx cloudflared tunnel --url http://localhost:5173   # terminal 2 -> prints an https URL
```

Open the printed `https://…trycloudflare.com` on the phone. Real cert, no warnings, works on iOS Safari.
Add the tunnel host to Vite so HMR/host-checking doesn't reject it:

```ts
// vite.config.ts
export default defineConfig({ server: { host: true, allowedHosts: true } });
```

### Local HTTPS instead (no internet dependency)

```bash
npm i -D @vitejs/plugin-basic-ssl
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, port: 5173 }, // host:true = listen on the LAN, prints the Network URL
});
```

Then on the phone open `https://<your-mac-lan-ip>:5173` (`ipconfig getifaddr en0` on macOS).
iOS shows "This Connection Is Not Private" → **Show Details → visit this website → Visit**. You must accept the cert
**before** the camera prompt appears; if you accepted it for a *different* port earlier, accept it again.
Both laptop and phone must be on the same Wi‑Fi, and the Mac firewall must allow incoming connections for node.

Android Chrome alternative: `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.x.x:5173`,
relaunch. (Dev only.)

## Error model — every branch is named and rendered

Everything the hook can fail at has a `kind`, a `message`, a `hint` and a `recoverable` flag — and `retry()` does the
*right* thing per kind rather than blindly re-calling `getUserMedia`.

| `kind` | When | What `retry()` does |
|---|---|---|
| `insecure-context` | page served over http on a non-localhost origin | nothing — no retry button, upload fallback only |
| `unsupported-browser` | no `mediaDevices` (in-app browsers: Instagram, LinkedIn, some WebViews) | nothing — upload fallback |
| `permission-denied` | `NotAllowedError` / `SecurityError` (also: iframe without `allow="camera"`) | re-requests, re-prompting the user |
| `no-camera` | `NotFoundError` | nothing — upload fallback |
| `camera-busy` | `NotReadableError` — Zoom/FaceTime/another tab holds it | re-acquires |
| `overconstrained` | `OverconstrainedError` | **drops the constraints to `video: true`** and re-acquires |
| `playback-blocked` | stream acquired but `video.play()` rejected (autoplay policy) | **replays the existing stream** — no second permission prompt |
| `stream-ended` | track `ended` fired mid-session (camera unplugged / OS revoked) | re-acquires |
| `capture-failed` | preview not ready, no 2D context, or empty `toBlob` | n/a — thrown from `capture()`, shown inline |

`capture()` rejects with a `CameraFailure`, which **extends `Error`** — so `e instanceof Error`, `e.message`,
`e.kind` and `e.hint` all work in your own `catch`. It never resolves with a placeholder blob.

### Iframe gotcha

Inside an `<iframe>` (Cursor's preview pane, Notion embeds, an in-app web view) `getUserMedia` throws
`NotAllowedError` **even after the user grants permission**, unless the parent sets
`<iframe allow="camera; microphone">`. The `permission-denied` hint says so; if you own the parent page, add the
attribute — there is no in-frame workaround.

**Graceful degradation:** whenever the live camera fails the component renders *two* file inputs, not one:

```html
<input type="file" accept="image/*" capture="environment">   <!-- opens the camera app -->
<input type="file" accept="image/*" multiple>                <!-- opens the photo library -->
```

Two on purpose: `capture` forces the camera app **and silently disables `multiple`**, which is exactly wrong when the
camera is the thing that failed (`no-camera`, in-app browser). Both feed the identical `Shot` pipeline — same
`readImageSize`, same `toBase64`, zero mock data. Both work over plain http.

## Payload sizing

`toBase64` defaults to `maxDimension: 1024`, `maxBytes: 900_000`. It steps quality 0.85 → 0.50, then resolution ×0.75,
up to 6 bounded passes; if it still doesn't fit it **throws** rather than sending a truncated image. Base64 is ~1.37×
the byte count on the wire. 1024px ≈ 1.1k input tokens on claude-sonnet — fine for a per-shot round trip.
Use `maxDimension: 1568` only when reading fine text (receipts, labels).

Stick to the default `image/jpeg`. `canvas.toBlob` **silently returns PNG** when the browser lacks the codec you asked
for (Safari < 14 + webp), which would ship PNG bytes labelled `image/webp` and earn a 400 from the vision API — so
`encode()` compares `blob.type` against what you requested and throws with the real reason instead of mislabelling.
`image/png` skips the quality ladder entirely (PNG ignores `quality`) and goes straight to shrinking pixels.

```ts
import { toBase64, toAnthropicImageBlock, toOpenAIImageBlock } from './camera/toBase64';
const img = await toBase64(shot.blob);           // throws loudly on a bad blob
toAnthropicImageBlock(img);                      // { type:'image', source:{ type:'base64', media_type, data } }
toOpenAIImageBlock(img);                         // { type:'image_url', image_url:{ url: dataUrl } }
```

## Gotchas already handled

- **React 19 StrictMode** double-mounts effects; the acquire effect uses a cancellation flag so the second run doesn't
  leave an orphaned camera light on.
- **`playsInline` + `muted`** are set both as JSX props and imperatively — without them iOS Safari opens the video
  fullscreen instead of inline.
- **EXIF rotation**: `createImageBitmap(blob, { imageOrientation: 'from-image' })`, with two fallbacks for older Safari,
  so uploaded phone photos aren't sent sideways.
- **Blob URL leaks**: every preview URL is revoked on remove and on unmount.
- Tracks are stopped on unmount/`stop()` — otherwise the camera indicator stays lit and the next `getUserMedia`
  can fail with `NotReadableError`.
- **`loadedmetadata` never fires twice** for the same stream, so replaying after `playback-blocked` would hang at
  "Starting camera…" forever. The bind effect also reads `video.readyState` directly.
- **Multi-file adds** update the shot-count ref synchronously, so selecting 20 photos with `maxShots={4}` adds exactly
  4 and tells you `16 file(s) skipped` — it never silently drops the rest.
