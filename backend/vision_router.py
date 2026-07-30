# vision_router.py — POST /api/vision/extract: base64 images + a schema name -> validated structured output.
# COPY: into backend/ with detect.py + vision_images.py, next to kit/backend-llm's provider/clients/errors/schema.py.
# CHANGE: VISION_SCHEMAS — register the Pydantic model your app actually wants back, and delete SceneReading.

from __future__ import annotations

import time
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

try:  # works whether backend/ is a package or a flat script dir
    from .detect import detect_router
    from .errors import LLMError
    from .provider import complete_structured_with_model
    from .vision_images import ImagePayload, reject_oversized_body, to_image_inputs
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from detect import detect_router  # type: ignore[no-redef]
    from errors import LLMError  # type: ignore[no-redef]
    from provider import complete_structured_with_model  # type: ignore[no-redef]
    from vision_images import ImagePayload, reject_oversized_body, to_image_inputs  # type: ignore[no-redef]


class UnknownSchema(LLMError):
    """The caller asked for a shape this backend does not know. Names the registered ones."""

    code = "unknown_schema"
    status = 422


# --- the shapes you want back ------------------------------------------------
# Keep every result model FLAT — str / float / bool / Literal / list[str]. The OpenAI
# fallback strips constraints (min_length, ge, pattern), so they buy nothing and cost a 400.

# The category list is closed on purpose: it is the grouping key for the spending
# statistics, and a free-text category would fragment the pie chart into singletons.
CATEGORIES = Literal[
    "electronics",
    "transport",
    "home",
    "fashion",
    "food",
    "health",
    "entertainment",
    "tools",
    "other",
]


class ItemReading(BaseModel):
    """What the camera saw, priced. `price_confidence` is the model's own, uncalibrated."""

    name: str = Field(description="Short retail name of the main object, e.g. 'AirPods Pro 2'.")
    category: CATEGORIES = Field(description="Best-fitting spending category for this object.")
    brand: str = Field(description="Brand if it is legible or unmistakable, otherwise empty.")
    condition: Literal["new", "used", "unknown"] = Field(description="Visible condition of this item.")
    estimated_price: float = Field(description="Typical retail price of this item in the stated currency.")
    currency: str = Field(description="ISO 4217 code for estimated_price, e.g. 'CAD'.")
    price_confidence: float = Field(description="0.0-1.0 confidence in estimated_price.")
    price_basis: str = Field(description="One sentence on what the estimate is based on.")
    alternatives: list[str] = Field(description="Cheaper items that serve the same purpose. Empty if none apply.")


VISION_SCHEMAS: dict[str, type[BaseModel]] = {"item": ItemReading}

VISION_SYSTEM = (
    "You read images and return exactly the requested structure. Report only what is visible; "
    "if a field cannot be filled from the image, leave it empty rather than guessing. "
    "For prices, give the typical current retail price of the object you actually see, and say "
    "in price_basis what that number is based on. Never invent a brand that is not legible."
)


class ExtractRequest(BaseModel):
    schema_name: str = Field(description="A key in VISION_SCHEMAS.")
    images: list[ImagePayload] = Field(min_length=1)
    prompt: str | None = Field(default=None, max_length=4000, description="Extra instruction for this call.")
    system: str | None = Field(default=None, max_length=2000, description="Replaces VISION_SYSTEM entirely.")


class ExtractResponse(BaseModel):
    schema_name: str
    result: dict[str, Any] = Field(description="An instance of VISION_SCHEMAS[schema_name], already validated.")
    model: str
    elapsed_ms: int


class SchemaListResponse(BaseModel):
    names: list[str]
    schemas: dict[str, Any] = Field(description="JSON Schema per name, so the client can render the fields.")


vision_router = APIRouter(prefix="/api/vision", tags=["vision"], dependencies=[Depends(reject_oversized_body)])


@vision_router.get("/schemas", response_model=SchemaListResponse)
def schemas() -> SchemaListResponse:
    """What `schema_name` accepts. Lets the UI fail on a typo before spending a model call."""
    return SchemaListResponse(
        names=sorted(VISION_SCHEMAS),
        schemas={name: model.model_json_schema() for name, model in VISION_SCHEMAS.items()},
    )


@vision_router.post("/extract", response_model=ExtractResponse)
def extract(request: ExtractRequest) -> ExtractResponse:
    """Images in, validated structure out. Every failure is a named error; nothing is ever stubbed.

    `def`, not `async def`: FastAPI runs it in a threadpool, so the blocking SDK call cannot
    freeze the event loop while a second phone is hitting the same backend.
    """
    schema_model = VISION_SCHEMAS.get(request.schema_name)
    if schema_model is None:
        known = ", ".join(sorted(VISION_SCHEMAS)) or "none"
        raise UnknownSchema(
            f"No schema named '{request.schema_name}'. Registered: {known}. "
            "Add your Pydantic model to VISION_SCHEMAS in vision_router.py."
        )
    # Enforces the image count and the byte ceilings, raising PayloadTooLarge / InvalidImage.
    images = to_image_inputs(request.images)

    prompt = "\n\n".join(
        part
        for part in (
            f"Read the attached image{'s' if len(images) > 1 else ''} and return a {schema_model.__name__}.",
            request.prompt.strip() if request.prompt else None,
        )
        if part
    )
    started = time.perf_counter()
    result, model = complete_structured_with_model(
        prompt, schema_model, images=images, system=request.system or VISION_SYSTEM
    )
    return ExtractResponse(
        schema_name=request.schema_name,
        result=result.model_dump(),
        model=model,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )


# /detect lives in detect.py and mounts here, so the team includes ONE router.
vision_router.include_router(detect_router)
