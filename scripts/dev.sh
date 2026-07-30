#!/usr/bin/env bash
# The whole app in one command: FastAPI on :8000 and Vite (HTTPS) on :5173, both bound
# to 0.0.0.0 so a phone on the same Wi-Fi can reach them. Ctrl+C stops both.
# Change ports via API_PORT / WEB_PORT; force an address with LAN_IP=192.168.x.x.

set -euo pipefail
set -m  # job control: each server gets its own process group, so we can kill its children too

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT"          # the Vite app lives at the project root (index.html, package.json)
API_DIR="$ROOT/backend"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
VENV_PY="$API_DIR/.venv/bin/python"
QRCODE_PIN="qrcode>=7.4,<9"

API_PID=""
WEB_PID=""

say()  { printf '\033[36m→\033[0m %s\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

cleanup() {
  trap - INT TERM EXIT
  [ -n "$WEB_PID$API_PID" ] || return 0
  printf '\n'
  say "stopping…"
  for pid in "$WEB_PID" "$API_PID"; do
    [ -n "$pid" ] || continue
    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
# Ctrl+C is a normal way to stop: exit 0 so `make dev` does not end on "Error 130/143",
# which reads like a crash. The bare EXIT trap keeps a real failure's exit code intact.
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Only LISTENers, never an established connection that happens to use this port —
# otherwise a browser tab left open from the last run gets killed instead of the server.
free_port() {
  local pids
  pids="$(lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    say "port $1 was busy — killing the stale listener"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

sha_of() { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null || echo "no-hash"; }

# --- sanity ------------------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found — install Python 3.11+"
command -v npm     >/dev/null || die "npm not found — install Node 20+ (brew install node)"
[ -f "$WEB_DIR/package.json" ]      || die "no package.json at $WEB_DIR — is this the project root?"
[ -f "$API_DIR/requirements.txt" ]  || die "no backend/requirements.txt next to scripts/"

if [ -f "$API_DIR/app/main.py" ]; then
  APP_MODULE="app.main:app"
elif [ -f "$API_DIR/main.py" ]; then
  APP_MODULE="main:app"
else
  die "no backend entrypoint: expected backend/main.py or backend/app/main.py"
fi

# --- first-run bootstrap -----------------------------------------------------
REQ_STAMP="$API_DIR/.venv/.requirements.sha"

if [ ! -x "$VENV_PY" ]; then
  say "creating backend/.venv (first run)"
  python3 -m venv "$API_DIR/.venv" || die "python3 -m venv failed — install Python 3.11+"
  "$VENV_PY" -m pip install --quiet --upgrade pip
fi

# Reinstall whenever requirements.txt changed — a teammate adding a dependency must not
# leave your venv silently one package behind.
if [ "$(sha_of "$API_DIR/requirements.txt")" != "$(cat "$REQ_STAMP" 2>/dev/null || true)" ]; then
  say "installing backend dependencies"
  "$VENV_PY" -m pip install --quiet -r "$API_DIR/requirements.txt" "$QRCODE_PIN" \
    || die "pip install failed — read the error above"
  sha_of "$API_DIR/requirements.txt" > "$REQ_STAMP"
fi

if [ ! -d "$WEB_DIR/node_modules" ]; then
  say "npm install (first run — this takes a minute)"
  npm --prefix "$WEB_DIR" install || die "npm install failed — read the error above"
fi

# --- run ---------------------------------------------------------------------
free_port "$API_PORT"
free_port "$WEB_PORT"

say "backend  $APP_MODULE → 0.0.0.0:$API_PORT"
(cd "$API_DIR" && exec "$VENV_PY" -m uvicorn "$APP_MODULE" --host 0.0.0.0 --port "$API_PORT" --reload) &
API_PID=$!

# NO_QR: vite.config.ts prints its own QR on `npm run dev`. Here we print a better one
# (with both URLs) after everything is up, so tell Vite to stay quiet — otherwise the
# terminal scrolls two QR codes and you scan the one that is off-screen.
#
# BACKEND_URL: vite.config.ts defaults its /api proxy to 127.0.0.1:8000. Without this line
# `API_PORT=8001 make dev` starts the backend on 8001 while the proxy keeps talking to 8000
# — every /api call fails (or, worse, reaches a different project's server) while the banner
# says the backend is up. Pass the port we actually used.
say "frontend Vite (https) → 0.0.0.0:$WEB_PORT"
(cd "$WEB_DIR" && NO_QR=1 BACKEND_URL="http://127.0.0.1:$API_PORT" exec npm run dev -- --host 0.0.0.0 --port "$WEB_PORT" --strictPort) &
WEB_PID=$!

# Wait for Vite, then print the URL block last so it stays at the bottom of the screen.
WEB_UP=0
for _ in $(seq 1 60); do
  if port_open "$WEB_PORT"; then WEB_UP=1; break; fi
  kill -0 "$WEB_PID" 2>/dev/null || die "the frontend died on startup — read the error above"
  sleep 0.5
done
[ "$WEB_UP" = 1 ] || warn "Vite has not opened :$WEB_PORT after 30s — the URLs below may not answer yet"

# The backend is slower to fail than to start: check it, do not assume it.
API_UP=0
for _ in $(seq 1 20); do
  if port_open "$API_PORT"; then API_UP=1; break; fi
  sleep 0.5
done
[ "$API_UP" = 1 ] || warn "the backend is NOT listening on :$API_PORT — /api will 502. Scroll up for the traceback."

# One detector, in lan.py: it filters loopback, link-local and the 100.64/10 range that
# iOS refuses. LAN_IP=… is honoured there too.
IP="$("$VENV_PY" "$ROOT/scripts/lan.py" --ip-only 2>/dev/null || true)"
"$VENV_PY" "$ROOT/scripts/lan.py" --ip "$IP" --web-port "$WEB_PORT" --api-port "$API_PORT" || {
  printf '\n  Local  https://localhost:%s\n  Phone  https://%s:%s\n\n' "$WEB_PORT" "$IP" "$WEB_PORT"
}

wait
