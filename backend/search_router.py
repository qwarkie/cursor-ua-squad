# search_router.py — POST /api/search: Tavily web search -> typed results. Mounts /ground from ground.py.
# COPY: into backend/ with ground.py; add httpx (requirements-search.txt); needs kit/backend-llm's errors.py.
# CHANGE: DEFAULT_MAX_RESULTS / DEFAULT_DEPTH below. The key is read from TAVILY_API_KEY at call time.

from __future__ import annotations

import os
import time
from typing import Literal

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, Field, ValidationError

try:  # works whether backend/ is a package or a flat script dir
    from .errors import LLMError
    from .ground import MAX_SOURCES, Source, ground_router
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from errors import LLMError  # type: ignore[no-redef]
    from ground import MAX_SOURCES, Source, ground_router  # type: ignore[no-redef]

TAVILY_URL = "https://api.tavily.com/search"
# Tavily answers a basic search in about a second; 20s means it is hung, not slow.
TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0)
DEFAULT_MAX_RESULTS = 5
DEFAULT_DEPTH: Literal["basic", "advanced"] = "basic"


# Every way retrieval can fail, named. No path here answers without sources: falling back to the
# model's own memory would hide a broken demo until the judges are watching.
class SearchKeyMissing(LLMError):
    """No TAVILY_API_KEY on the backend."""
    code = "search_key_missing"
    status = 503


class SearchKeyRejected(LLMError):
    """A key is set and Tavily refused it (401/403)."""
    code = "search_key_rejected"
    status = 503


class SearchRateLimited(LLMError):
    """Tavily 429. Per-account, so retrying in the same second will not help."""
    code = "search_rate_limited"
    status = 429


class SearchQuotaExceeded(LLMError):
    """Tavily 432/433 — the free-tier credits or the pay-as-you-go ceiling is spent."""
    code = "search_quota_exceeded"
    status = 402


class SearchUpstreamFailed(LLMError):
    """Tavily answered with an error, or with a body this router cannot read."""
    code = "search_upstream_failed"
    status = 502


class SearchUnreachable(LLMError):
    """The backend could not open the connection at all."""
    code = "search_unreachable"
    status = 502


class SearchTimeout(LLMError):
    """Tavily did not answer inside the read timeout."""
    code = "search_timeout"
    status = 504


class SearchResult(Source):
    """A Source plus Tavily's relevance score, so results POST straight back to /api/search/ground."""

    score: float = Field(description="Tavily relevance, roughly 0..1. Render it; do not threshold silently.")


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    # Ceiling is ground.py's MAX_SOURCES, not Tavily's: retrieving more than /ground accepts
    # would hand the frontend results it can never cite, and the failure would land one
    # round trip later as an opaque 422. Raise both constants together or neither.
    max_results: int = Field(default=DEFAULT_MAX_RESULTS, ge=1, le=MAX_SOURCES)
    search_depth: Literal["basic", "advanced"] = DEFAULT_DEPTH
    topic: Literal["general", "news", "finance"] = "general"
    include_domains: list[str] = Field(default_factory=list, max_length=20)
    time_range: Literal["day", "week", "month", "year"] | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult] = Field(description="Empty is a real answer: nothing matched. Never padded.")
    elapsed_ms: int


class _TavilyResult(BaseModel):
    """Tavily's own shape. Strict on url/score so a changed API surfaces as an error, not as blanks."""

    url: str
    score: float
    title: str = ""
    content: str = ""


class _TavilyEnvelope(BaseModel):
    results: list[_TavilyResult]


search_router = APIRouter(prefix="/api/search", tags=["search"])


def _api_key() -> str:
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise SearchKeyMissing(
            "TAVILY_API_KEY is not set on the backend, so there is nothing to search with. "
            "Add TAVILY_API_KEY=tvly-... to backend/.env (source: kit/env/vault.env) and restart the API."
        )
    return key


def _upstream_error(status: int, body: str) -> LLMError:
    detail = body[:300]
    if status in (401, 403):
        return SearchKeyRejected(
            f"Tavily rejected TAVILY_API_KEY with {status}: {detail}. "
            "Regenerate it at tavily.com -> dashboard and update backend/.env."
        )
    if status == 429:
        return SearchRateLimited(
            f"Tavily rate limit hit: {detail}. Wait a few seconds and retry — this router does not retry for you.",
            retry_after=5.0,
        )
    if status in (432, 433):
        return SearchQuotaExceeded(
            f"The Tavily plan limit is spent ({status}): {detail}. "
            "Use another account's key, or drop search_depth to 'basic' to halve the credit cost per call."
        )
    if status == 400:
        return SearchUpstreamFailed(
            f"Tavily refused the request ({status}): {detail}. Usually an unsupported topic/time_range "
            "combination — check the values you sent."
        )
    return SearchUpstreamFailed(f"Tavily returned {status}: {detail}. Check status.tavily.com.")


@search_router.post("", response_model=SearchResponse)
async def search(request: SearchRequest) -> SearchResponse:
    """Query in, real web results out. Every failure is a named error; nothing is ever stubbed."""
    key = _api_key()
    payload = {
        "query": request.query,
        "max_results": request.max_results,
        "search_depth": request.search_depth,
        "topic": request.topic,
        "include_domains": request.include_domains,
        # Tavily's own summary is deliberately off: an answer we did not ground is not an answer.
        "include_answer": False, "include_raw_content": False, "include_images": False,
    }
    if request.time_range is not None:
        payload["time_range"] = request.time_range

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                TAVILY_URL,
                headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise SearchTimeout(f"Tavily did not answer within {TIMEOUT.read:.0f}s. Retry, or raise TIMEOUT here.") from exc
    except httpx.HTTPError as exc:
        raise SearchUnreachable(
            f"Could not reach Tavily: {type(exc).__name__}: {exc}. Check the backend's own internet access — "
            "venue Wi-Fi often blocks outbound TLS."
        ) from exc

    if response.status_code >= 400:
        raise _upstream_error(response.status_code, response.text)

    try:
        envelope = _TavilyEnvelope.model_validate_json(response.text)
    except ValidationError as exc:
        raise SearchUpstreamFailed(
            "Tavily answered 200 with a body this router cannot read. Update _TavilyResult in search_router.py "
            "to match the current API.",
            detail=exc.errors()[:3],
        ) from exc

    return SearchResponse(
        query=request.query,
        results=[
            SearchResult(title=item.title, url=item.url, snippet=item.content, score=item.score)
            for item in envelope.results
        ],
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )


# /ground lives in ground.py and mounts here, so the team includes ONE router.
search_router.include_router(ground_router)
