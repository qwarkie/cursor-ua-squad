<!-- README.md — how to drop the vision module into a fresh repo. -->
<!-- COPY: nothing from this file ships; it is instructions only. -->
<!-- CHANGE: nothing. Read it, take the files, edit VISION_SCHEMAS. -->

# vision — image in, typed structure out

A photo goes up, a **validated Pydantic model** comes back — plus a second route that returns
**labelled regions with boxes normalised to `[0..1]`**, so one overlay component is correct at
every resolution, on a phone or a projector.

| File | Where it goes | Needs |
| --- | --- | --- |
| `visionTypes.ts` | `src/lib/vision/` | — (state union, typed error, box) |
| `encodeSupport.ts` | `src/lib/vision/` | — (can this browser encode at all) |
| `encodeImage.ts` | `src/lib/vision/` | `encodeSupport.ts` (Blob → downscaled base64) |
| `visionClient.ts` | `src/lib/vision/` | `visionTypes.ts` (the two POSTs, timeouts, typed failures) |
| `useVision.ts` | `src/lib/vision/` | react + the three above |
| `boxGeometry.ts` | `src/lib/vision/` | — (pure `object-fit` maths) |
| `BoxOverlay.tsx` | `src/lib/vision/` | react + `boxGeometry.ts` |
| `index.ts` | `src/lib/vision/` | barrel — `import { useVision } from '@/lib/vision'` |
| `vision_images.py` | `backend/` | `kit/backend-llm` (`clients.py`, `errors.py`) |
| `detect.py` | `backend/` | `vision_images.py`, `provider.py`, `errors.py` |
| `vision_router.py` | `backend/` | all of the above |

## Copy

```bash
BASE=~/Desktop/cursor-hackathon-base
mkdir -p src/lib/vision && cp $BASE/kit/vision/*.ts $BASE/kit/vision/*.tsx src/lib/vision/
cp $BASE/kit/vision/{vision_images,detect,vision_router}.py backend/
```

**No extra pip packages.** This module rides on `kit/backend-llm`, so its
`requirements-llm.txt` (`anthropic`, `openai`) is the only install — and you already appended it.

## Wire the backend — two lines in `backend/main.py`

```python
from errors import register_error_handlers   # from kit/backend-llm
from vision_router import vision_router

register_error_handlers(app)      # without this, every failure is a bodyless 500
app.include_router(vision_router) # mounts /api/vision/extract, /detect and /schemas
```

Then edit **one thing**: `VISION_SCHEMAS` in `vision_router.py`. Register the flat Pydantic
model you actually want back (`str` / `float` / `bool` / `Literal` / `list[str]` — the OpenAI
fallback strips `min_length`, `ge` and `pattern`, so they only cost you a 400).

## Use

```tsx
import { useRef } from 'react';
import { BoxOverlay } from '@/lib/vision/BoxOverlay';
import { useVision } from '@/lib/vision/useVision';

const imageRef = useRef<HTMLImageElement>(null);
const vision = useVision<{ summary: string }>({ schemaName: 'scene' });
const regions = vision.detection.status === 'ready' ? vision.detection.data.regions : [];

<div className="relative overflow-hidden rounded-xl">
  <img ref={imageRef} src={photoUrl} alt="" className="h-64 w-full object-cover" />
  <BoxOverlay mediaRef={imageRef} regions={regions} />
</div>
<button onClick={() => void vision.detect(blob)}>Find regions</button>
{vision.extraction.status === 'error' && <p className="text-error-primary">{vision.extraction.error.message}</p>}
```

`blob` is whatever `input-camera-photo`'s `capture()` returned. `extract()` also takes an array
(up to 4 images), and both accept an already-encoded image, so `toBase64()`'s `EncodedImage`
from `input-camera-photo` can be passed straight through with no re-encode.

`matchVision(state, {...})` gives you an exhaustive switch: forget the `unsupported` branch and
the build fails. Its `unsupported` handler takes **one object** — `({ capability, reason, hint })`
— not the positional pair `ui-states`' `match` uses, so a handler copied across is a compile
error instead of a silently swapped string. `vision.retryExtract()` / `retryDetect()` re-run the
last call — wire them to the retry button.

## Traps, and their fixes

- **Boxes drift on a phone but look right on the laptop.** The media is `object-fit: cover` and
  the overlay is doing naive percentage maths. `BoxOverlay` reads the computed `object-fit` and
  `object-position` and projects through the real crop — but it must sit **inside the same
  `relative` wrapper as the media**, and the media needs `ref={mediaRef}`.
- **No boxes at all on a `<video>`.** Nothing is drawn until `loadedmetadata` gives the stream a
  size. That is the honest state, not a bug; the overlay re-measures itself when the event fires.
- **Every failure is a 500 with no body.** `register_error_handlers(app)` is missing from
  `main.py`. The named errors (`payload_too_large`, `invalid_image`, `unknown_schema`,
  `parse_failure`, `missing_credentials`) all travel through that handler.
- **`invalid_image: labelled image/webp but the bytes are not`.** Safari silently encodes PNG
  when it cannot do webp. Pass `encode: { mediaType: 'image/jpeg' }` to `useVision`.
- **`payload_too_large`.** Per image 3.5 MB decoded, 8 MB per request, 4 images. Lower
  `encode.maxDimension` (default 1024px long edge) or raise the constants in `vision_images.py`.
- **`unknown_schema`.** `schemaName` must be a key in `VISION_SCHEMAS`. `GET /api/vision/schemas`
  lists what is registered.
- **A region came back in `dropped`, not `regions`.** The model answered in pixels instead of
  fractions; the reason string says exactly that. Restate the fraction rule in `_build_prompt`
  in `detect.py` and re-run. Boxes are never rescaled on a guess.
- **`network_error` on the phone but not the laptop.** The page must be on the LAN HTTPS origin
  from `make dev`; the camera needs a secure context anyway.
- **Timeouts.** A cold vision model takes 15–30s, and `provider.py` falls through `MODELS` at
  60s per model, so the honest worst case is minutes. The client gives up at **120s** — long
  enough for one fallback. If you see `timeout` while the uvicorn log shows the call still
  running, either raise `useVision({ timeoutMs })` or trim `MODELS` in `provider.py`.
- **The photo appears but no boxes, and no error.** Usually a media element mounted later than
  the overlay (`{photo && <img ref={mediaRef} />}`). `BoxOverlay` re-resolves `mediaRef` after
  every commit, so this now heals itself — but the media and the overlay must still share one
  `relative` wrapper, and the box coordinates only mean anything for the image you actually sent.

## Composes with

`input-camera-photo` (its `capture()` Blob and `EncodedImage` are the inputs) and
`input-camera-live` (point `BoxOverlay` at the same `videoRef`, and throttle `detect()` — one
call per user tap, never per frame). `ui-states` shares the vocabulary; `backend-llm` is required.
