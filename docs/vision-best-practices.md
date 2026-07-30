# Vision best practices — camera → `ItemReading`

Reference for the one model call the whole product rests on: a photo goes up, an
`ItemReading` comes back, and `affordability.py` turns it into a verdict. If `name`,
`brand`, or `estimated_price` are wrong, every number downstream is confidently wrong.

This is a **reference doc, not a changelog** — nothing here has been applied. Sections 2,
3 and 5 name a mismatch between this repo and Anthropic's documented guidance, and spell
out the fix. Sections 4 and 6 record what is already correct, so a refactor doesn't undo
it.

Sources: [Vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[Coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates).

---

## 1. How Claude sees an image

Claude reads images in **28×28 pixel patches**, one visual token per patch:

```
tokens = ceil(width / 28) × ceil(height / 28)
```

Every model has **two** limits, and both bind:

| Tier | Models | Max long edge | Max visual tokens |
|---|---|---|---|
| High-resolution | Claude 4.7 and later — `claude-sonnet-5`, `claude-opus-5` | 2576 px | 4784 |
| Standard | everything else — `claude-haiku-4-5` | 1568 px | 1568 |

An image over either limit is **silently downscaled** (aspect preserved) to the largest
size that fits both, then padded up to the next multiple of 28 on the bottom and right
edges only. Padding never moves the origin. High-resolution is automatic on the models
that support it — no beta header, no opt-in.

### The trap: the token limit binds first, not the edge limit

For nearly every photo it is the **token budget** that decides the final size. The edge
limit only takes over on elongated images. Two consequences:

- A 1920×1080 frame lands at **1456×819**, not 1568×882.
- An image can be under the edge limit on both sides and still be resized. A 1075×1520
  scan costs 39 × 55 = 2145 tokens, so the standard tier resizes it to 924×1307 — while
  the high-resolution tier leaves it alone, because 2145 is inside its 4784 budget.

**Never scale to the edge length by hand.** Compute it:

```python
import math

def count_image_tokens(w: int, h: int) -> int:
    """Visual tokens consumed by an image: one token per 28x28 pixel patch."""
    return math.ceil(w / 28) * math.ceil(h / 28)

def resized_size(width: int, height: int,
                 max_edge: int = 1568, max_tokens: int = 1568) -> tuple[int, int]:
    """The size Claude resizes an image to before padding.

    Defaults are the standard tier. For high-resolution models pass
    max_edge=2576, max_tokens=4784. Images already within the limits come back
    unchanged.
    """
    def fits(w: int, h: int) -> bool:
        return (math.ceil(w / 28) * 28 <= max_edge
                and math.ceil(h / 28) * 28 <= max_edge
                and count_image_tokens(w, h) <= max_tokens)

    if fits(width, height):
        return (width, height)
    if height > width:
        rh, rw = resized_size(height, width, max_edge, max_tokens)
        return (rw, rh)

    aspect = width / height
    lo, hi = 1, width            # lo always fits; hi never fits
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fits(mid, max(round(mid / aspect), 1)):
            lo = mid
        else:
            hi = mid
    return (lo, max(round(lo / aspect), 1))
```

A TypeScript port is in the coordinates doc. It needs banker's rounding
(`roundTiesToEven`) rather than `Math.round`, because the API resolves exact `.5` ties to
the even neighbour.

---

## 2. Capture sizing

Target the **standard tier** (1568 px / 1568 tokens). That is the smaller of the two
budgets, so an image sized for it is read pixel-for-pixel by *every* model in the
`provider.py` chain — the reading does not shift when Sonnet 5 rate-limits and Haiku 4.5
picks up the request. Cost lands around **1560 visual tokens** per shot either way.

### There is no single correct `maxDimension`

The binding constraint is **area**, not long edge, so the right long edge depends on
aspect ratio. Verified against the helper above at `(1568, 1568)`:

| Capture aspect | Send | Tokens | Note |
|---|---|---|---|
| 16:9 landscape | **1456×819** | 1560 | fits exactly |
| 4:3 landscape | **1270×952** | 1564 | fits exactly |
| 3:4 portrait (iPhone default) | **952×1270** | 1564 | fits exactly |
| 1:1 | **1092×1092** | 1521 | fits exactly |

A fixed `maxDimension: 1456` would be exact for 16:9 and then get 4:3 server-downscaled
from 1456×1092 (2028 tokens) to 1270×952 — the model still sees 1270×952, so the reading
is unharmed, but the extra bytes buy nothing and box coordinates stop mapping 1:1.

**Recommendation: port `resizedSize()` into `src/lib/vision/encodeImage.ts`** and derive
the target from the decoded capture dimensions instead of a constant. This is the
documented "pre-resize before uploading" approach, and it is what makes the coordinate
fix in §3 exact.

### Current state and the delta

`DEFAULTS` in `src/lib/vision/encodeImage.ts` is `maxDimension: 1024, quality: 0.85`,
with `maxBytes: 3_000_000`.

- **1024 px under-spends the budget.** A 1024×768 capture costs 1036 tokens against a
  1568 budget — roughly a third of the available detail left unused, on a task whose
  hardest sub-problem is reading a brand name off a box.
- **The quality ladder is backwards for this use case.** `encodeImage()` steps quality
  0.85 → 0.50 in 0.15 decrements and only *then* multiplies resolution by 0.75.
  Anthropic's guidance is explicit that lossy compression artifacts hurt the model,
  "especially when multiple compression passes are applied", and that heavy JPEG
  compression makes text hard to read. Shed **resolution before quality**, with a floor
  around 0.80. In practice the ladder rarely fires at these sizes — a 1270×952 JPEG at
  q0.85 is far under the 3 MB ceiling — so this is about the worst case, not the common
  one.

### Also worth knowing

- **JPEG only.** Safari silently emits PNG when asked for a codec it lacks, which would
  mean PNG bytes labelled `image/webp` and a 422 from `vision_images.py`'s magic-byte
  sniff. `encodeCanvas()` already compares `blob.type` against the request and throws
  with the real reason.
- **Bake orientation into the pixels.** Claude parses no image metadata whatsoever, so
  EXIF rotation is invisible to it. `decode()` handles this with
  `createImageBitmap(blob, { imageOrientation: 'from-image' })` and falls back to `<img>`
  on older Safari.
- Supported formats are JPEG, PNG, GIF and WebP. Animations are not supported — only the
  first frame is read.
- Hard ceilings, well above anything this app sends: 8000×8000 px per image, 10 MB
  base64 per image on the Claude API (5 MB on Bedrock/Vertex, which is what
  `MAX_IMAGE_BYTES = 3_500_000` in `vision_images.py` is sized against), 100 images per
  request on 200k-context models.

---

## 3. Bounding boxes — `/detect` prompts against the grain

The guidance is unambiguous:

> **Claude works best with absolute pixel coordinates.** Ask for them explicitly in your
> prompt. […] Claude does not work well when you ask for normalized coordinates […]
> Always ask for pixel coordinates and normalize in your own code if you need to.

`backend/detect.py` does the opposite, in three places:

- `RawDetection` asks for `x`, `y`, `width`, `height` as *"a FRACTION of image width,
  0.0-1.0"*.
- `_build_prompt()` restates the fraction rule at length (*"Coordinates are FRACTIONS of
  the image, not pixels"*).
- `_normalise()` then **discards** any box falling outside `0..1 ± 0.02`, with the
  reason *"the model answered in pixels rather than fractions, so its position cannot be
  mapped to this image"*. If every box is discarded, `detect()` raises `ParseFailure`
  telling the operator to *"restate the fraction rule in `_build_prompt`"*.

So the pipeline asks for the format the model is worst at, and then treats the
documented-correct answer as a parse failure and advises doubling down. The `dropped`
bucket and that `ParseFailure` are the predicted symptom, not a mystery.

### The fix

The wire format does **not** change. `DetectResponse` keeps emitting `[0..1]` fractions,
so `NormalisedBox` in `src/lib/vision/visionTypes.ts`, `projectBox()` in
`boxGeometry.ts`, and `BoxOverlay` are all untouched. Only the model-facing half moves:

1. `RawDetection` becomes pixel corners — `x1`, `y1`, `x2`, `y2` — on the image *as
   sent*.
2. `_build_prompt()` asks for exactly that: *"Return the bounding box of each object as
   `[x1, y1, x2, y2]` (top-left and bottom-right corners) in pixel coordinates"*, origin
   top-left, x rightward, y downward. State the image's pixel dimensions in the prompt.
3. `_normalise()` divides by the **resized** dimensions to produce the fractions the
   frontend already consumes. Clamp to the resized dimensions *before* dividing, so a
   point slightly outside the frame can't map outside the image.
4. **Divide by resized, never padded, dimensions.** Padding is added to the bottom and
   right up to the next multiple of 28; dividing by padded dimensions scales every
   coordinate by a small amount — a bug that looks like drift rather than breakage.
5. **Match the tier to the model that actually answered.**
   `complete_structured_with_model()` already returns the model id for exactly this kind
   of reason: pass `(1568, 1568)` for `claude-haiku-4-5` and `(2576, 4784)` for
   `claude-sonnet-5`. The wrong tier recovers the wrong resized dimensions and silently
   shifts every box. If §2 is implemented, the image is already at its target and the
   resize is a no-op on both tiers — which is the point of pre-resizing.

Keep the existing honesty properties: a genuinely empty list stays a valid answer, and
anything unusable still lands in `dropped` with a stated reason rather than being quietly
dropped.

For small targets, precision comes from **cropping and re-sending the region** (then
offsetting the returned coordinates by the crop origin), not from upscaling. Spot-check
boxes visually before trusting them at scale.

---

## 4. Request shape — already correct

Verified in this repo. Recorded because each is easy to undo by accident.

- **Images before text.** `call_anthropic()` in `backend/clients.py` builds the image
  blocks first and appends the text block after. This matches the documented ordering
  ("Claude works best when images come before text"), and the same holds in
  `call_openai()`.
- **Structured output.** `messages.parse(output_format=schema)` returning
  `response.parsed_output` is the right shape, and is also what the coordinates doc
  recommends for getting boxes back as machine-readable JSON. Note the top-level
  `output_format` on `messages.create()` is deprecated in favour of
  `output_config.format`, but the convenience parameter on `.parse()` is still
  supported — **no change needed here.**
- **`stop_reason` is checked before reading output**, for both `refusal` and
  `max_tokens`, each raising a named `ParseFailure`.
- **Flat result models.** The `# keep it FLAT` rule in `vision_router.py` is about the
  OpenAI fallback stripping `min_length` / `ge` / `pattern`, but it aligns with the
  structured-output schema limits generally: no recursion, no numeric or string
  constraints, `additionalProperties: false`.

### One gap

`/extract` accepts up to 4 images (`MAX_IMAGES` in `vision_images.py`) and sends them
with no labels. When sending several images, introduce each with a short text label —
`Image 1:`, `Image 2:` — so the prompt and any follow-up can refer to them
unambiguously. Single-image requests need nothing.

---

## 5. iPhone capture — the upload fallback beats the live preview

Counterintuitive, and it inverts how the two paths in `CameraCapture.tsx` are framed:

- **iOS Safari's `getUserMedia` commonly caps the video track near 720p**, regardless of
  the constraint. `useCameraPhoto.ts` asks for `width: { ideal: 1920 }` and will often
  get 1280×720 anyway. `ImageCapture` is unavailable on iOS, so
  `canvas.drawImage(video)` off the preview track is the hard ceiling — `capture()`
  cannot do better than the track it is handed.
- **`<input type="file" accept="image/*" capture="environment">`** hands off to the
  native camera app, which returns a full-sensor frame (~3024×4032 on a 12 MP sensor).

`CameraCapture.tsx:124` and `:128` already render both inputs on the failure path, and
both feed the identical `encodeImage` pipeline. So the "graceful degradation" fallback
supplies a **better** image to the model than the happy path does. Two implications:

- Raising the encode ceiling per §2 mostly helps the upload path. The live path is
  capture-bound near 720p, and a 1280×720 frame is 1196 tokens — most of the standard
  budget already, and nothing is gained by upscaling it.
- If reading fine print (a model number, a spec label) turns out to matter, the honest
  fix is to route the user to the native-camera input for that shot, not to ask
  `getUserMedia` for more pixels.

Operational facts that already have handling in `cameraErrors.ts`: the camera needs a
secure context (`https://`, `localhost`, `127.0.0.1` — a LAN IP over http has no
`navigator.mediaDevices` at all, which is what `make dev` and `scripts/lan.py` exist
for), permission needs a user gesture, and an `<iframe>` needs `allow="camera"` on the
parent.

---

## 6. Limits to design around

- **People.** Claude will not name people in images and refuses to.
- **Small and low-quality images.** Interpretation of images under ~200 px, heavily
  rotated, or low-quality is unreliable and may be hallucinated.
- **Counting** is approximate, especially with many small objects.
- **Spatial reasoning** is approximate — see §3.
- **AI-generated images** cannot be detected. Don't ask.
- **No metadata**, so nothing can be inferred from EXIF (see §2).

These reinforce the stance already in `README.md`: `price_confidence` is the model's own
uncalibrated number — render it, never silently threshold on it — and
`affordability.py`'s `compute()` stays the only source of every figure the UI shows. The
model supplies words and a reading; Python supplies every number.

---

## Applying this

Roughly in value order:

1. **§3, `backend/detect.py`** — switch the prompt and schema to pixel coordinates,
   normalize server-side. Recovers detections the current code discards by design.
2. **§2, `src/lib/vision/encodeImage.ts`** — port `resizedSize()`, target the standard
   tier per aspect ratio, raise the quality floor to ~0.80 and shed resolution first.
3. **§4** — add `Image N:` labels to multi-image `/extract` calls.
