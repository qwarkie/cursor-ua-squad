# errors.py — named LLM failures + FastAPI handlers that map each to a distinct HTTP status.
# COPY: drop next to provider.py in your backend/; call register_error_handlers(app) once at startup.
# CHANGE: nothing required. Add a subclass here if your domain needs another failure mode.

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class LLMError(Exception):
    """Base for every failure this backend admits to. Never swallowed, never faked."""

    code: str = "llm_error"
    status: int = 500

    def __init__(self, message: str, retry_after: float | None = None, detail: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after
        self.detail = detail


class MissingCredentials(LLMError):
    """No usable API key: either none is set, or the one that is set was rejected (401/403)."""

    code = "missing_credentials"
    status = 503


class UpstreamRejected(LLMError):
    """The provider refused the request we built (bad model id, unsupported schema, bad params)."""

    code = "upstream_rejected"
    status = 500


class ProviderUnavailable(LLMError):
    """Every model in the registry failed (rate limited, down, or refused to connect)."""

    code = "provider_unavailable"
    status = 502


class UpstreamTimeout(LLMError):
    """The model did not answer inside the client timeout."""

    code = "upstream_timeout"
    status = 504


class ParseFailure(LLMError):
    """The model answered, but the answer did not satisfy the requested schema."""

    code = "parse_failure"
    status = 500


def _body(code: str, message: str, retry_after: float | None = None, detail: Any = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if retry_after is not None:
        payload["retry_after"] = round(retry_after, 1)
    if detail is not None:
        payload["detail"] = detail
    return payload


def register_error_handlers(app: FastAPI) -> None:
    """Give the frontend one machine-readable error contract: {code, message}."""

    @app.exception_handler(LLMError)
    async def _llm_error(_: Request, exc: LLMError) -> JSONResponse:
        headers = {}
        if exc.retry_after is not None:
            headers["Retry-After"] = str(int(max(1.0, exc.retry_after)))
        return JSONResponse(
            status_code=exc.status,
            content=_body(exc.code, exc.message, exc.retry_after, exc.detail),
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", ())[1:]) or "body"
        return JSONResponse(
            status_code=422,
            content=_body("invalid_request", f"{field}: {first.get('msg', 'invalid input')}"),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        # Hard-fail loudly. We never return a placeholder result on an unknown error.
        return JSONResponse(
            status_code=500,
            content=_body("internal_error", f"{type(exc).__name__}: {exc}"),
        )
