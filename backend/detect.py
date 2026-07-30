# detect.py — POST /api/vision/detect: labelled regions with boxes normalised to [0..1].
# COPY: into backend/ next to vision_router.py + vision_images.py. It mounts itself onto vision_router.
# CHANGE: DETECT_SYSTEM and _build_prompt for your domain; MAX_DETECTIONS for how many regions you want.

from __future__ import annotations

import math
import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

try:  # works whether backend/ is a package or a flat script dir
    from .errors import ParseFailure
    from .provider import complete_structured_with_model
    from .vision_images import ImagePayload, to_image_inputs
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from errors import ParseFailure  # type: ignore[no-redef]
    from provider import complete_structured_with_model  # type: ignore[no-redef]
    from vision_images import ImagePayload, to_image_inputs  # type: ignore[no-redef]

MAX_DETECTIONS = 20
# A box 2% outside the frame is a rounding artefact worth clamping. Further out means the
# model answered in a different coordinate space, and clamping it would invent a location.
TOLERANCE = 0.02

DETECT_SYSTEM = (
    "You locate things in images. You answer only with regions you can actually see, "
    "and you never invent an object to fill the list."
)


# --- what the model returns (kept flat: the OpenAI fallback path rejects constraints) ---
class RawDetection(BaseModel):
    label: str = Field(description="Two or three words naming the thing, lowercase.")
    confidence: float = Field(description="0.0-1.0, how sure you are this region is what you labelled it.")
    x: float = Field(description="Left edge as a FRACTION of image width, 0.0-1.0.")
    y: float = Field(description="Top edge as a FRACTION of image height, 0.0-1.0.")
    width: float = Field(description="Width as a FRACTION of image width, 0.0-1.0.")
    height: float = Field(description="Height as a FRACTION of image height, 0.0-1.0.")


class RawDetections(BaseModel):
    detections: list[RawDetection]


# --- what the frontend gets -------------------------------------------------
class Box(BaseModel):
    x: float
    y: float
    width: float
    height: float


class Region(BaseModel):
    label: str
    confidence: float
    box: Box


class DroppedRegion(BaseModel):
    """A detection whose box was unusable. Reported, so the UI can say so out loud."""

    label: str
    reason: str


class DetectRequest(BaseModel):
    image: ImagePayload
    labels: list[str] = Field(default_factory=list, description="Optional closed vocabulary. Empty = model's own labels.")
    prompt: str | None = Field(default=None, max_length=2000)
    max_detections: int = Field(default=12, ge=1, le=MAX_DETECTIONS)


class DetectResponse(BaseModel):
    regions: list[Region]
    dropped: list[DroppedRegion]
    model: str
    elapsed_ms: int


detect_router = APIRouter(tags=["vision"])


def _normalise(raw: RawDetection) -> Region | DroppedRegion:
    """Clamp a near-miss box into the frame; report anything further out instead of guessing."""
    x0, y0 = raw.x, raw.y
    x1, y1 = raw.x + raw.width, raw.y + raw.height
    corners = (x0, y0, x1, y1)
    if not all(math.isfinite(value) for value in corners):
        return DroppedRegion(label=raw.label, reason="the model returned a non-finite coordinate")
    if min(corners) < -TOLERANCE or max(corners) > 1 + TOLERANCE:
        return DroppedRegion(
            label=raw.label,
            reason=(
                f"box ({x0:.2f},{y0:.2f})-({x1:.2f},{y1:.2f}) falls outside 0..1 — the model answered "
                "in pixels rather than fractions, so its position cannot be mapped to this image"
            ),
        )
    x0, y0 = max(0.0, x0), max(0.0, y0)
    x1, y1 = min(1.0, x1), min(1.0, y1)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return DroppedRegion(label=raw.label, reason="box has zero area once clamped to the frame")
    return Region(
        label=raw.label,
        confidence=min(1.0, max(0.0, raw.confidence)),
        box=Box(x=x0, y=y0, width=x1 - x0, height=y1 - y0),
    )


def _build_prompt(request: DetectRequest) -> str:
    parts = [
        f"Find up to {request.max_detections} distinct regions in this image.",
        "Coordinates are FRACTIONS of the image, not pixels: the origin (0,0) is the top-left "
        "corner and (1,1) is the bottom-right corner. A box covering the left half of the image "
        "is x=0.0, y=0.0, width=0.5, height=1.0.",
        "One entry per distinct thing. Do not merge separate objects into one box, and do not "
        "return a box for something you cannot see. An empty list is a valid answer.",
    ]
    if request.labels:
        parts.append("Use only these labels, and ignore anything else: " + ", ".join(request.labels) + ".")
    if request.prompt:
        parts.append(request.prompt.strip())
    return "\n\n".join(parts)


@detect_router.post("/detect", response_model=DetectResponse)
def detect(request: DetectRequest) -> DetectResponse:
    """One image in, labelled boxes out. Boxes are fractions, so the overlay works at any resolution."""
    images = to_image_inputs([request.image], field="image")
    started = time.perf_counter()
    parsed, model = complete_structured_with_model(
        _build_prompt(request), RawDetections, images=images, system=DETECT_SYSTEM
    )
    regions: list[Region] = []
    dropped: list[DroppedRegion] = []
    for index, raw in enumerate(parsed.detections):
        # Truncation is reported, not silent: a missing box on screen must have a stated reason.
        if index >= request.max_detections:
            dropped.append(
                DroppedRegion(label=raw.label, reason=f"over the max_detections cap of {request.max_detections}")
            )
            continue
        outcome = _normalise(raw)
        if isinstance(outcome, Region):
            regions.append(outcome)
        else:
            dropped.append(outcome)

    # Zero detections is an honest answer. Detections that ALL had unusable boxes is a failure,
    # and returning an empty list for it would look identical to "nothing in the picture".
    if parsed.detections and not regions:
        raise ParseFailure(
            f"{model} returned {len(parsed.detections)} detections and none had a usable box: "
            f"{dropped[0].reason}. Re-run, or restate the fraction rule in _build_prompt.",
            detail=[item.model_dump() for item in dropped[:3]],
        )
    return DetectResponse(
        regions=regions,
        dropped=dropped,
        model=model,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )
