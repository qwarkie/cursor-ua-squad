# main.py — the FastAPI shell. Everything lives under /api so the Vite dev proxy
# forwards it and the frontend never hardcodes a LAN IP.
# Change here: mount routers below, and list any new API-key names in REQUIRED_ENV
# so /api/health guards them.

import os
import platform

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Keep this import ABOVE any capability module: importing settings loads backend/.env into
# os.environ, and SDK clients read their keys at import/construction time.
from settings import BACKEND_DIR, ENV_FILE, LAN_ORIGIN_REGEX, get_settings

settings = get_settings()

from affordability import affordability_router  # noqa: E402  (must follow settings)
from errors import register_error_handlers  # noqa: E402
from search_router import search_router  # noqa: E402
from store_router import router as store_router  # noqa: E402
from vision_router import vision_router  # noqa: E402

app = FastAPI(title="Worth It backend", version="0.1.0")

# Phones on the Wi-Fi hit the LAN IP, so the Origin header is never localhost.
# allow_origin_regex covers every private range; extra_origins is for tunnels.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.extra_origins,
    allow_origin_regex=LAN_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Without this every named failure — missing_credentials, payload_too_large, parse_failure —
# collapses into a bodyless 500 and the frontend cannot tell them apart.
register_error_handlers(app)

app.include_router(vision_router)         # /api/vision/extract, /detect, /schemas
app.include_router(affordability_router)  # /api/affordability/assess
app.include_router(search_router)         # /api/search, /api/search/ground
app.include_router(store_router)          # /api/items


# --- health ---------------------------------------------------------------
# Reports WHICH env vars are set, never their values. Returns 503 when a
# required one is missing — a broken config must fail loudly, not fake OK.


class Health(BaseModel):
    status: str = Field(description="'ok' or 'misconfigured'")
    python: str
    env_file: bool = Field(description="True if backend/.env exists. Missing file = the usual cause of a missing key.")
    env_present: list[str] = Field(description="Names of configured env vars. Values are never returned.")
    env_missing: list[str] = Field(description="Required names that are not set.")


@app.get("/api/health", response_model=Health)
def health(response: Response) -> Health:
    required = settings.required_env_names
    optional = settings.optional_env_names

    present = [name for name in required + optional if os.environ.get(name, "").strip()]
    missing = [name for name in required if not os.environ.get(name, "").strip()]

    if missing:
        response.status_code = 503

    return Health(
        status="ok" if not missing else "misconfigured",
        python=platform.python_version(),
        env_file=ENV_FILE.is_file(),
        env_present=present,
        env_missing=missing,
    )


# --- the domain lives in the routers --------------------------------------
# vision_router.py   reads the photo into an ItemReading
# affordability.py   turns an ItemReading + a Profile into a verdict
# search_router.py   grounds the price against the live web, with citations
# store_router.py    keeps the history on disk at backend/data/store.db
#
# Every endpoint in them is `def`, not `async def`: FastAPI runs those in a
# threadpool, so a 60s blocking model call never freezes the event loop.


if __name__ == "__main__":
    import uvicorn

    # host defaults to 0.0.0.0 — bind all interfaces or phones cannot reach this.
    # reload_dirs pins the watcher to backend/: uvicorn's default is the current working
    # directory, so launching from the repo root would watch node_modules and restart the
    # API on every frontend edit. reload_excludes keeps .venv out of the watch set.
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        reload_dirs=[str(BACKEND_DIR)],
        reload_excludes=[".venv/*", "__pycache__/*"],
    )
