# ground.py — question + sources -> an answer where every claim carries the index of the source it came from.
# COPY: into backend/ with search_router.py, beside kit/backend-llm's provider/clients/errors/schema.py.
# CHANGE: GROUND_SYSTEM for your domain's voice, and MAX_SOURCES / MAX_SNIPPET_CHARS if you feed more in.

from __future__ import annotations

import time

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator, model_validator

try:  # works whether backend/ is a package or a flat script dir
    from .errors import LLMError
    from .provider import complete_structured_with_model
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from errors import LLMError  # type: ignore[no-redef]
    from provider import complete_structured_with_model  # type: ignore[no-redef]


class CitationOutOfRange(LLMError):
    """The model cited a source number that was never supplied. The answer is refused, not trimmed."""

    code = "citation_out_of_range"
    status = 502


class NoSourcesToGround(LLMError):
    """ground() was handed an empty source list. Answering anyway is exactly what this module forbids."""

    code = "no_sources_to_ground"
    status = 400


MAX_SOURCES = 10
MAX_QUESTION_CHARS = 500
# Enough of each page for the claim to be checkable; more only buys tokens and latency.
MAX_SNIPPET_CHARS = 1200


class Source(BaseModel):
    """One retrieved document. search_router's SearchResult is this plus a score."""

    title: str = Field(default="", description="Page title. Empty is allowed — the UI falls back to the host.")
    url: str = Field(description="The link the citation opens.")
    snippet: str = Field(default="", description="The extract the claim must be traceable to.")


class Claim(BaseModel):
    """One sentence of the answer. `sources` is what makes the citation real rather than decorative."""

    text: str = Field(description="One self-contained sentence. No hedging, no 'according to the sources'.")
    sources: list[int] = Field(
        description="0-based indexes of the numbered sources this sentence came from. At least one, never empty."
    )

    @field_validator("sources")
    @classmethod
    def _must_cite(cls, value: list[int]) -> list[int]:
        # This is the whole mechanism: an uncited claim fails schema validation, which
        # clients.py turns into a ParseFailure. It can never reach the UI as plain text.
        if not value:
            raise ValueError("a claim with no source index is not grounded — cite the source it came from")
        return value


class GroundedAnswer(BaseModel):
    claims: list[Claim] = Field(description="The answer in reading order. Every entry cites its sources.")
    gaps: str = Field(
        description="What the question asked that these sources do not answer. Empty string if they cover it."
    )

    @model_validator(mode="after")
    def _explain_silence(self) -> "GroundedAnswer":
        if not self.claims and not self.gaps.strip():
            raise ValueError("no claims and no gaps note — state what the sources failed to answer")
        return self


GROUND_SYSTEM = (
    "You answer strictly from the numbered sources you are given. Every claim must be traceable to at "
    "least one of them by index. You never fall back on prior knowledge, you never guess, and you never "
    "cite a number that is not in the list. Whatever the sources do not cover belongs in `gaps`."
)


def _numbered_sources(sources: list[Source]) -> str:
    return "\n\n".join(
        f"[{index}] {source.title or source.url}\nURL: {source.url}\n{source.snippet[:MAX_SNIPPET_CHARS]}"
        for index, source in enumerate(sources)
    )


def _build_prompt(question: str, sources: list[Source]) -> str:
    return (
        f"Question:\n{question}\n\n"
        f"Sources (the number in brackets is the index to cite):\n{_numbered_sources(sources)}\n\n"
        "Answer as an ordered list of claims. Each claim is one self-contained sentence and lists the "
        f"indexes of the sources it came from — valid indexes are 0 to {len(sources) - 1}. A statement you "
        "cannot attribute to a source does not belong in the answer; describe it in `gaps` instead."
    )


def _out_of_range(answer: GroundedAnswer, count: int) -> list[int]:
    return sorted({i for claim in answer.claims for i in claim.sources if i < 0 or i >= count})


def ground(question: str, sources: list[Source], system: str | None = None) -> tuple[GroundedAnswer, str]:
    """Question + sources -> (validated answer, model that produced it). Raises; never returns filler."""
    # GroundRequest already enforces min_length=1, but ground() is exported and a team calling
    # it from their own endpoint with [] would otherwise get an answer from the model's memory.
    if not sources:
        raise NoSourcesToGround(
            "ground() was called with no sources, so there is nothing an answer could cite. "
            "Search first and pass the results — an ungrounded answer is what this module exists to prevent."
        )
    prompt = _build_prompt(question, sources)
    used_system = system or GROUND_SYSTEM
    answer, model = complete_structured_with_model(prompt, GroundedAnswer, system=used_system)

    invalid = _out_of_range(answer, len(sources))
    if not invalid:
        return answer, model

    # One corrective pass naming the exact violation. Deleting the offending claim would be a
    # silent edit of the answer, and renumbering it would invent a citation — both are worse.
    correction = (
        f"\n\nYour previous attempt cited source(s) {invalid}, which do not exist. Valid indexes are "
        f"0 to {len(sources) - 1}. Rewrite the answer, keeping only claims you can attribute."
    )
    answer, model = complete_structured_with_model(prompt + correction, GroundedAnswer, system=used_system)

    invalid = _out_of_range(answer, len(sources))
    if invalid:
        raise CitationOutOfRange(
            f"{model} cited source(s) {invalid} but only 0-{len(sources) - 1} were supplied, twice in a row. "
            "The answer is not grounded, so it is not returned. Retry, or lower max_results — a long source "
            "list is the usual cause.",
            detail={"cited": invalid, "source_count": len(sources)},
        )
    return answer, model


class GroundRequest(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    sources: list[Source] = Field(min_length=1, max_length=MAX_SOURCES, description="Usually /api/search's results.")
    system: str | None = Field(default=None, max_length=2000, description="Replaces GROUND_SYSTEM entirely.")


class GroundResponse(BaseModel):
    question: str
    claims: list[Claim]
    gaps: str
    model: str
    elapsed_ms: int


# No prefix: this mounts inside search_router, so the team includes ONE router.
ground_router = APIRouter(tags=["search"])


@ground_router.post("/ground", response_model=GroundResponse)
def ground_endpoint(request: GroundRequest) -> GroundResponse:
    """`def`, not `async def`: FastAPI runs it in a threadpool, so the blocking SDK call
    cannot freeze the event loop while a second phone is hitting the same backend."""
    started = time.perf_counter()
    answer, model = ground(request.question, request.sources, request.system)
    return GroundResponse(
        question=request.question,
        claims=answer.claims,
        gaps=answer.gaps,
        model=model,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
    )
