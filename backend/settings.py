# settings.py — all backend configuration in one place, and the ONE place that loads
# backend/.env into the real process environment (importing this module has that side effect).
# Change here: port, extra CORS origins, and the REQUIRED_ENV / OPTIONAL_ENV name lists.

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent
ENV_FILE = BACKEND_DIR / ".env"

# Load .env into os.environ. This is NOT redundant with SettingsConfigDict(env_file=...):
# that only fills the fields declared on Settings below. API keys are never declared here,
# so without this call OPENAI_API_KEY sitting in backend/.env stays invisible to
# os.getenv(), to /api/health, and to every SDK that auto-reads its key from the
# environment (openai, anthropic, ...) — the classic "the key IS in my .env" dead end.
# override=False: an env var exported in the shell always beats the file.
load_dotenv(ENV_FILE, override=False)

# Origins a phone on the same Wi-Fi will actually send.
# Covers localhost, 10.x, 192.168.x, 172.16-31.x (incl. iPhone hotspot 172.20.10.x),
# 169.254.x (self-assigned when venue DHCP dies) and *.local (mDNS/Bonjour), on any
# port, over both http and https. Starlette full-matches this against the Origin header.
LAN_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost"
    r"|127\.0\.0\.1"
    r"|\[::1\]"
    r"|10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|169\.254\.\d{1,3}\.\d{1,3}"
    r"|[A-Za-z0-9-]+\.local"
    r")(:\d{1,5})?$"
)


class Settings(BaseSettings):
    """Backend config. Every field can be overridden by an env var of the same name."""

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- server ---------------------------------------------------------
    # 0.0.0.0 is deliberate: bind all interfaces or phones on the LAN cannot reach it.
    host: str = "0.0.0.0"
    port: int = 8000
    reload: bool = True

    # --- CORS -----------------------------------------------------------
    # Comma-separated exact origins, added on top of LAN_ORIGIN_REGEX.
    # Put a tunnel URL (ngrok/cloudflared) here if you use one.
    extra_allowed_origins: str = ""

    # --- env var contract -----------------------------------------------
    # Comma-separated NAMES only. /api/health reports which are present and
    # returns 503 if a required one is missing. Values are never echoed.
    # e.g. required_env="OPENAI_API_KEY" once you drop in the kit LLM module.
    required_env: str = ""
    optional_env: str = ""

    @property
    def extra_origins(self) -> list[str]:
        return _split(self.extra_allowed_origins)

    @property
    def required_env_names(self) -> list[str]:
        return _split(self.required_env)

    @property
    def optional_env_names(self) -> list[str]:
        return _split(self.optional_env)


def _split(raw: str) -> list[str]:
    """Comma-separated string -> clean list. Kept out of the model so env parsing
    stays plain strings (pydantic-settings would demand JSON for a list field)."""
    return [item.strip() for item in raw.split(",") if item.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
