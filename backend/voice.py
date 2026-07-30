# voice.py — POST /api/voice/transcribe: recorded audio in, text out, via Groq Whisper.
#
# The key never reaches the browser: the clip is uploaded here and forwarded server-side.
# Groq is used rather than the browser's own SpeechRecognition because that API does not
# exist on Firefox, is Google-hosted on Chrome, and returns nothing usable on iOS Safari —
# a phone is the primary device for this app, so the reliable path is the only path.

from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field

try:  # works whether backend/ is a package or a flat script dir
    from .errors import LLMError
except ImportError:  # pragma: no cover - depends on how the team runs uvicorn
    from errors import LLMError  # type: ignore[no-redef]


class VoiceKeyMissing(LLMError):
    """No Groq key. The UI disables the mic and keeps the text field working."""

    code = "voice_key_missing"
    status = 503


class ClipTooLarge(LLMError):
    code = "clip_too_large"
    status = 413


class EmptyClip(LLMError):
    code = "empty_clip"
    status = 422


class TranscriptionRejected(LLMError):
    """Groq answered, and said no. The reason is passed through verbatim."""

    code = "transcription_rejected"
    status = 502


class TranscriptionUnreachable(LLMError):
    code = "transcription_unreachable"
    status = 502


GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
# turbo is several times cheaper and faster than whisper-large-v3, at the same word error
# rate on short clips — which is all this app records.
MODEL = "whisper-large-v3-turbo"
# Groq's own ceiling is 25 MB. Two minutes of Opus is ~250 KB, so anything near this is a
# bug in the client rather than a long sentence.
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT_S = 60.0


class Transcript(BaseModel):
    text: str = Field(description="What was said. Empty when the clip held no speech.")
    model: str
    bytes_sent: int


voice_router = APIRouter(prefix="/api/voice", tags=["voice"])


@voice_router.get("/status")
def status() -> dict[str, bool | str]:
    """Lets the UI hide the mic before the user taps it and gets a 503 in their face."""
    configured = bool(os.getenv("GROQ_API_KEY", "").strip())
    return {
        "configured": configured,
        "model": MODEL if configured else "",
        "reason": "" if configured else "GROQ_API_KEY is not set in backend/.env.",
    }


@voice_router.post("/transcribe", response_model=Transcript)
def transcribe(
    clip: UploadFile = File(description="Audio recorded by the browser: webm/opus, mp4 or wav."),
    language: str = Form(default="", description="ISO-639-1 hint, e.g. 'en'. Empty lets Whisper detect it."),
) -> Transcript:
    """`def`, not `async def`: FastAPI runs this in a threadpool, so the blocking upload
    to Groq cannot stall the event loop while another phone is talking."""
    key = os.getenv("GROQ_API_KEY", "").strip()
    if not key:
        raise VoiceKeyMissing(
            "GROQ_API_KEY is not set, so speech cannot be transcribed. Add it to backend/.env "
            "and restart the API, because .env is read once, at import. Typing still works."
        )

    audio = clip.file.read()
    if not audio:
        raise EmptyClip("The uploaded clip is empty. Hold the mic button while speaking.")
    if len(audio) > MAX_BYTES:
        raise ClipTooLarge(
            f"The clip is {len(audio) // 1024} KB and the ceiling is {MAX_BYTES // 1024} KB. "
            "Record a shorter take."
        )

    data: dict[str, str] = {"model": MODEL, "response_format": "json"}
    if language.strip():
        data["language"] = language.strip()

    try:
        response = httpx.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {key}"},
            files={"file": (clip.filename or "clip.webm", audio, clip.content_type or "audio/webm")},
            data=data,
            timeout=TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        raise TranscriptionUnreachable(
            f"Could not reach Groq: {exc}. Check the network, because nothing about this runs offline."
        ) from exc

    if response.status_code == 401:
        raise VoiceKeyMissing("Groq rejected the key (401). GROQ_API_KEY is set but not valid.")
    if response.status_code >= 400:
        # Pass the provider's own words through: "model not found" and "file too short" are
        # different problems and guessing between them wastes the user's time.
        raise TranscriptionRejected(f"Groq returned {response.status_code}: {response.text[:400]}")

    body = response.json()
    text = body.get("text")
    if not isinstance(text, str):
        raise TranscriptionRejected(f"Groq returned no text field. Body was: {str(body)[:300]}")

    return Transcript(text=text.strip(), model=MODEL, bytes_sent=len(audio))
