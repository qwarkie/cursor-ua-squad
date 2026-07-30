# vision_images.py — base64 image payloads: decode, sniff, and a hard size ceiling with a NAMED error.
# COPY: into backend/ next to provider.py + errors.py (from kit/backend-llm). Imported by vision_router.py and detect.py.
# CHANGE: MAX_IMAGES / MAX_IMAGE_BYTES / MAX_TOTAL_BYTES below to trade latency for detail.

from __future__ import annotations

import base64
import binascii
from typing import Callable, Literal, Sequence

from fastapi import Request
from pydantic import BaseModel, Field

try:  # works whether backend/ is a package or a flat script dir
    from .clients import ImageInput
    from .errors import LLMError
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from clients import ImageInput  # type: ignore[no-redef]
    from errors import LLMError  # type: ignore[no-redef]

MAX_IMAGES = 4
# Decoded bytes per image. 3.5 MB decoded is ~4.7 MB base64, under Anthropic's 5 MB image block.
MAX_IMAGE_BYTES = 3_500_000
MAX_TOTAL_BYTES = 8_000_000
# Raw JSON body. base64 inflates by 4/3 and JSON adds quoting on top of that.
MAX_BODY_BYTES = 16_000_000


class PayloadTooLarge(LLMError):
    """Over the ceiling. Still carries the {code, message} envelope, so the UI can print the fix."""

    code = "payload_too_large"
    status = 413


class InvalidImage(LLMError):
    """The bytes are not the image they claim to be. Never silently re-labelled or dropped."""

    code = "invalid_image"
    status = 422


class ImagePayload(BaseModel):
    media_type: Literal["image/jpeg", "image/png", "image/webp", "image/gif"]
    data: str = Field(description="Raw base64. A `data:<type>;base64,` prefix is accepted and stripped.")


# The provider 400s on bytes that do not match media_type, and that error names nothing useful.
# Sniffing here turns it into one sentence with the fix in it.
_MAGIC: dict[str, Callable[[bytes], bool]] = {
    "image/jpeg": lambda b: b[:3] == b"\xff\xd8\xff",
    "image/png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n",
    "image/gif": lambda b: b[:6] in (b"GIF87a", b"GIF89a"),
    "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}


def _mb(value: int) -> str:
    return f"{value / 1_000_000:.1f} MB"


def decode_image(payload: ImagePayload, where: str) -> bytes:
    """Base64 -> bytes, with every failure named. `where` is the JSON path of this image
    ('image' or 'images[0]') so the message points at the field the caller actually sent.
    Raises InvalidImage or PayloadTooLarge."""
    raw = payload.data.strip()
    if raw.startswith("data:"):
        comma = raw.find(",")
        if comma < 0:
            raise InvalidImage(f"{where} starts with 'data:' but has no comma — it is not a data URL.")
        raw = raw[comma + 1 :]
    raw = "".join(raw.split())  # some encoders wrap base64 at 76 chars; the SDKs reject that
    if not raw:
        raise InvalidImage(f"{where} carries no base64 data.")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidImage(
            f"{where} is not valid base64 ({exc}). Send the raw payload only — "
            "strip the `data:<type>;base64,` prefix before posting."
        ) from exc
    if not data:
        raise InvalidImage(f"{where} decoded to zero bytes.")
    if len(data) > MAX_IMAGE_BYTES:
        raise PayloadTooLarge(
            f"{where} is {_mb(len(data))}; the per-image ceiling is {_mb(MAX_IMAGE_BYTES)}. "
            "Lower maxDimension in encodeImage(), or raise MAX_IMAGE_BYTES in vision_images.py."
        )
    sniff = _MAGIC.get(payload.media_type)
    if sniff and not sniff(data):
        raise InvalidImage(
            f"{where} is labelled {payload.media_type} but the bytes are not {payload.media_type}. "
            "Browsers silently fall back to PNG when they cannot encode a format — encode as image/jpeg."
        )
    return data


def to_image_inputs(payloads: Sequence[ImagePayload], field: str = "images") -> list[ImageInput]:
    """Validate the whole set against the ceilings, then hand clean base64 to the provider layer.

    `field` names the request field in every error message: "images" for /extract, "image" for
    /detect. A message pointing at a field the caller never sent costs minutes to chase down.
    """
    if not payloads:
        raise InvalidImage(f"The request carries no image in `{field}`. Send at least one.")
    if len(payloads) > MAX_IMAGES:
        raise PayloadTooLarge(
            f"{len(payloads)} images in one request; the ceiling is {MAX_IMAGES}. "
            "Send them in separate calls, or raise MAX_IMAGES in vision_images.py."
        )
    single = len(payloads) == 1 and field == "image"
    total = 0
    images: list[ImageInput] = []
    for index, payload in enumerate(payloads):
        data = decode_image(payload, field if single else f"{field}[{index}]")
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise PayloadTooLarge(
                f"The images total {_mb(total)}; the request ceiling is {_mb(MAX_TOTAL_BYTES)}. "
                "Send fewer images per call, or raise MAX_TOTAL_BYTES in vision_images.py."
            )
        images.append(
            ImageInput(media_type=payload.media_type, data=base64.b64encode(data).decode("ascii"))
        )
    return images


async def reject_oversized_body(request: Request) -> None:
    """Router dependency: refuse a body far over the ceiling with a body the frontend can read,
    instead of letting a proxy answer with an HTML 413 that fetch() cannot parse."""
    declared = request.headers.get("content-length")
    if declared is None:
        return
    try:
        length = int(declared)
    except ValueError:
        return
    if length > MAX_BODY_BYTES:
        raise PayloadTooLarge(
            f"Request body is {_mb(length)}; the ceiling is {_mb(MAX_BODY_BYTES)}. "
            "Downscale before sending — encodeImage() defaults to a 1024px long edge."
        )
