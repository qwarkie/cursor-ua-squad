# clients.py — one function per provider SDK; each maps raw SDK exceptions to this kit's named failures.
# COPY: keep beside provider.py and errors.py. provider.py imports from here.
# CHANGE: MAX_TOKENS / TIMEOUT_S below; add a call_<provider>() to support another SDK.

from __future__ import annotations

import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Sequence, Type, TypeVar

from pydantic import BaseModel, ValidationError

try:  # works as a package (backend.clients) or as a flat script dir
    from .errors import MissingCredentials, ParseFailure, UpstreamRejected, UpstreamTimeout
except ImportError:  # pragma: no cover
    from errors import MissingCredentials, ParseFailure, UpstreamRejected, UpstreamTimeout

T = TypeVar("T", bound=BaseModel)

MAX_TOKENS = 4096
TIMEOUT_S = 60.0


class ImageInput(BaseModel):
    media_type: str  # image/png | image/jpeg | image/webp | image/gif
    data: str  # raw base64: no "data:...;base64," prefix, no newlines


@dataclass(frozen=True)
class ModelSpec:
    provider: str  # "anthropic" | "openai"
    model: str
    env_key: str


class RateLimited(Exception):
    """429 on ONE model. Cool that model down, then try a DIFFERENT one."""

    def __init__(self, retry_after: float) -> None:
        super().__init__("rate limited")
        self.retry_after = retry_after


class Transient(Exception):
    """Provider-side failure (connection, 5xx) worth trying on a different model."""


def retry_after_seconds(exc: Exception, default: float = 20.0) -> float:
    """Obey the provider's own Retry-After (seconds or HTTP date) instead of guessing."""
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if not raw:
        return default
    try:
        return max(1.0, float(raw))
    except (TypeError, ValueError):
        pass
    try:
        return max(1.0, parsedate_to_datetime(str(raw)).timestamp() - time.time())
    except Exception:
        return default


def _map_error(exc: Exception, sdk: Any, spec: ModelSpec) -> Exception:
    """Raw SDK exception -> the named failure this backend reports. Order matters: subclasses first."""
    if isinstance(exc, sdk.RateLimitError):  # 429 — this model only
        return RateLimited(retry_after_seconds(exc))
    if isinstance(exc, (sdk.AuthenticationError, sdk.PermissionDeniedError)):  # 401 / 403
        return MissingCredentials(
            f"{spec.env_key} is set but {spec.provider} rejected it "
            f"({getattr(exc, 'status_code', '4xx')}). Paste a valid key into .env and restart."
        )
    if isinstance(exc, sdk.NotFoundError):  # 404 — model id typo in MODELS
        return UpstreamRejected(f"{spec.provider} has no model '{spec.model}'. Fix MODELS in provider.py.")
    if isinstance(exc, sdk.BadRequestError):  # 400 — usually an unsupported field in the result model
        return UpstreamRejected(
            f"{spec.model} rejected the request: {exc}. If you just edited the result model, "
            "keep it flat (str/float/bool/Literal/list[str]) and drop min_length/ge/pattern."
        )
    if isinstance(exc, sdk.APITimeoutError):
        return UpstreamTimeout(f"{spec.model} did not respond within {TIMEOUT_S:.0f}s")
    return Transient(f"{type(exc).__name__}: {exc}")


def call_anthropic(spec: ModelSpec, api_key: str, prompt: str, schema: Type[T],
                   images: Sequence[ImageInput], system: str) -> T:
    """Anthropic structured output: messages.parse(output_format=...) -> response.parsed_output."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key, timeout=TIMEOUT_S, max_retries=0)
    content: list[dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": i.media_type, "data": i.data}}
        for i in images]
    content.append({"type": "text", "text": prompt})
    try:
        response = client.messages.parse(
            model=spec.model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": content}],
            output_format=schema,
        )
    except anthropic.APIError as exc:
        raise _map_error(exc, anthropic, spec) from exc
    except ValidationError as exc:
        raise ParseFailure(f"{spec.model} returned JSON that is not a valid {schema.__name__}",
                           detail=exc.errors()[:3]) from exc

    if response.stop_reason == "refusal":
        raise ParseFailure(f"{spec.model} refused this request")
    if response.stop_reason == "max_tokens":
        raise ParseFailure(f"{spec.model} hit the {MAX_TOKENS}-token cap before finishing the structure")
    if response.parsed_output is None:
        raise ParseFailure(f"{spec.model} returned no parseable {schema.__name__}")
    return response.parsed_output


def call_openai(spec: ModelSpec, api_key: str, prompt: str, schema: Type[T],
                images: Sequence[ImageInput], system: str) -> T:
    """OpenAI structured output: strict json_schema response format, validated client-side."""
    import openai

    try:  # local import keeps the two provider paths independent
        from .schema import strict_schema
    except ImportError:  # pragma: no cover
        from schema import strict_schema

    client = openai.OpenAI(api_key=api_key, timeout=TIMEOUT_S, max_retries=0)
    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": f"data:{i.media_type};base64,{i.data}"}}
        for i in images]
    content.append({"type": "text", "text": prompt})
    try:
        response = client.chat.completions.create(
            model=spec.model,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": content}],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": schema.__name__, "strict": True,
                                "schema": strict_schema(schema.model_json_schema())},
            },
        )
    except openai.APIError as exc:
        raise _map_error(exc, openai, spec) from exc

    choice = response.choices[0]
    if getattr(choice.message, "refusal", None):
        raise ParseFailure(f"{spec.model} refused: {choice.message.refusal}")
    if choice.finish_reason == "length":
        raise ParseFailure(f"{spec.model} hit the {MAX_TOKENS}-token cap before finishing the structure")
    try:
        return schema.model_validate_json(choice.message.content or "")
    except ValidationError as exc:
        raise ParseFailure(f"{spec.model} returned JSON that is not a valid {schema.__name__}",
                           detail=exc.errors()[:3]) from exc
