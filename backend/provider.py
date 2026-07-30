# provider.py — one model registry, one call: complete_structured(prompt, SchemaModel) -> validated Pydantic.
# COPY: drop next to errors.py / clients.py / schema.py; `from provider import complete_structured`.
# CHANGE: MODELS (below) to pick your models, and DEFAULT_SYSTEM for your domain's voice.

from __future__ import annotations

import os
import time
from typing import Sequence, Type, TypeVar

from pydantic import BaseModel

try:  # works whether this folder is a package (backend.provider) or a flat script dir
    from .clients import (ImageInput, ModelSpec, RateLimited, Transient, call_anthropic,
                          call_openai)
    from .errors import MissingCredentials, ProviderUnavailable
except ImportError:  # pragma: no cover
    from clients import (ImageInput, ModelSpec, RateLimited, Transient, call_anthropic,
                         call_openai)
    from errors import MissingCredentials, ProviderUnavailable

T = TypeVar("T", bound=BaseModel)

__all__ = ["ImageInput", "MODELS", "complete_structured", "complete_structured_with_model",
           "credential_status", "ready_models"]

# Ordered fallback chain. A 429 is per-model, so the next entry is a DIFFERENT model.
MODELS: tuple[ModelSpec, ...] = (
    ModelSpec("anthropic", "claude-sonnet-5", "ANTHROPIC_API_KEY"),
    ModelSpec("anthropic", "claude-haiku-4-5", "ANTHROPIC_API_KEY"),
    ModelSpec("openai", "gpt-4o", "OPENAI_API_KEY"),
)

_CALLS = {"anthropic": call_anthropic, "openai": call_openai}

DEFAULT_SYSTEM = "You are a precise analysis engine. Return only the requested structure."

_cooldown: dict[str, float] = {}  # model id -> unix ts it becomes usable again


def credential_status() -> dict[str, bool]:
    """Which providers have a key present. Never returns the key itself."""
    return {spec.provider: bool(os.getenv(spec.env_key)) for spec in MODELS}


def ready_models() -> list[str]:
    """Models that are configured and not currently cooling down from a 429."""
    now = time.time()
    return [s.model for s in MODELS if os.getenv(s.env_key) and _cooldown.get(s.model, 0.0) <= now]


def complete_structured_with_model(prompt: str, schema_model: Type[T],
                                   images: Sequence[ImageInput] | None = None,
                                   system: str | None = None) -> tuple[T, str]:
    """Same as complete_structured, but also returns which model actually answered."""
    images = images or []
    system = system or DEFAULT_SYSTEM
    configured = [s for s in MODELS if os.getenv(s.env_key)]
    if not configured:
        raise MissingCredentials("No provider key set. Export ANTHROPIC_API_KEY (source: kit/env/vault.env).")

    now = time.time()
    usable = [s for s in configured if _cooldown.get(s.model, 0.0) <= now]
    if not usable:
        wait = min(_cooldown[s.model] for s in configured) - now
        raise ProviderUnavailable("Every configured model is rate limited.", retry_after=max(1.0, wait))

    failures: list[str] = []
    for spec in usable:
        try:
            result = _CALLS[spec.provider](spec, os.environ[spec.env_key], prompt,
                                           schema_model, images, system)
            return result, spec.model
        except RateLimited as exc:
            _cooldown[spec.model] = time.time() + exc.retry_after
            failures.append(f"{spec.model}: rate limited, retry in {exc.retry_after:.0f}s")
        except Transient as exc:
            failures.append(f"{spec.model}: {exc}")
        # MissingCredentials, UpstreamRejected, UpstreamTimeout and ParseFailure propagate
        # immediately: a bad key, a bad schema, or a blown time budget will not fix itself
        # on the next model, and silently trying costs the caller their whole request.

    raise ProviderUnavailable("All models failed. " + "; ".join(failures))


def complete_structured(prompt: str, schema_model: Type[T],
                        images: Sequence[ImageInput] | None = None,
                        system: str | None = None) -> T:
    """Ask the model chain for `schema_model`. Raises a named error; never returns fake data."""
    return complete_structured_with_model(prompt, schema_model, images, system)[0]
