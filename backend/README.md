# Backend

FastAPI shell. Bound to `0.0.0.0` so phones on the same Wi-Fi can reach it;
the frontend calls it through the Vite `/api` proxy, so no IP is ever hardcoded.

## Run

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # real keys come from kit/env/vault.env
python main.py                # == uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

`scripts/dev.sh` (the one command that starts everything) does all of this for you —
use it on event night.

Check: `curl http://localhost:8000/api/health` → `200 {"status":"ok",...}`,
or `503` with `env_missing` listing names you declared in `REQUIRED_ENV`.

## Contract with the frontend

- Port `8000`, every route prefixed `/api`. The Vite proxy forwards `/api` →
  `http://127.0.0.1:8000` **without rewriting the path**, so a new route must keep the
  prefix or the phone gets Vite's index.html instead of JSON.
- The backend stays plain http. Only Vite serves https; the proxy hop is server-to-server,
  so there is no mixed content. Do **not** point the frontend at `https://<LAN-IP>:8000` —
  that is an https page talking to an http origin and the browser kills it silently.
- CORS is open to the private LAN by regex (`10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`,
  `*.local`, any port, http or https). Anything else — a tunnel URL — goes in
  `EXTRA_ALLOWED_ORIGINS`, comma-separated.

## Traps this saves you from

**"My key is right there in `.env` and health still says 503."**
`settings.py` calls `load_dotenv()` at import so `backend/.env` lands in `os.environ`.
pydantic-settings' `env_file=` alone does *not* do this — it only fills the fields
declared on `Settings`, so an undeclared `OPENAI_API_KEY` would stay invisible to
`os.getenv()` and to the openai/anthropic SDKs. If you add a module that reads keys,
import it **below** `from settings import ...` in `main.py`.
`GET /api/health` reports `env_file: false` when `backend/.env` does not exist at all.

**Only `backend/.env` is read**, never a `.env` in the repo root. A key in the wrong
folder is silently ignored — check `env_file` in the health response.

**A shell-exported var beats the file** (`override=False`). If a stale
`export OPENAI_API_KEY=` is in your shell, editing `.env` changes nothing; `unset` it.

**Reload restarts only on `backend/` changes** (`reload_dirs`). If you launch uvicorn
by hand from the repo root, pass `--reload-dir backend` or every frontend save bounces
the API and watchfiles crawls `node_modules`.

**Blocking work needs `def`, not `async def`.** A `requests`/SDK/inference call inside
`async def` freezes the event loop and every other request — including the health check —
until it returns.

## Adapting it to a new domain

1. Add your endpoints in `main.py` next to `/api/echo` — one Pydantic model in, one out,
   `def` not `async def` if the work can block.
2. Put any new API-key names in `REQUIRED_ENV` in `.env` so `/api/health` fails loudly
   when a key is missing.
3. Add libraries to `requirements.txt` as ranges (`>=x,<y`), and drop kit modules into
   `backend/` alongside `main.py`.

### Dropping in `kit/backend-llm`

Its README says "copy the folder as `backend/`" — that is for a bare repo. Here it would
overwrite this `main.py` and you would lose the `/api` prefix and the LAN CORS regex, so
the phone would 404 on every call. Instead:

```bash
cp kit/backend-llm/{provider,clients,schema,errors}.py backend/
cat kit/backend-llm/requirements.txt >> backend/requirements.txt   # then dedupe
```

Then in this `main.py`: `from errors import register_error_handlers` +
`register_error_handlers(app)`, and copy the `/analyze` handler in as **`/api/analyze`**.
Add the key names you filled in (`ANTHROPIC_API_KEY`, ...) to `REQUIRED_ENV`.
