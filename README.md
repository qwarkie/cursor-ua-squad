# fintech-helper

Point a phone camera at an object in a shop and find out what buying it would cost
**you** — not its price tag, but its price measured against your own income: the share of
one month's disposable money, the hours of work behind it, the months of saving it adds.

Every scan is kept, so the history turns into spending statistics without anyone entering
a receipt by hand.

## The problem

A price tag is a number without a denominator. `$329` means something entirely different
to two people in the same queue, and neither of them can work out which one they are in
the four seconds before they tap the card. Budgeting apps answer the question afterwards,
from bank statements — which is the one moment the answer cannot change the outcome.

This app answers it in front of the shelf, from a photo, in one tap.

## How it works

1. **Once** — you enter net monthly income, committed monthly expenses, and current
   savings. Stored on the device, not on a server.
2. **In the shop** — you photograph the object. A vision model reads it into a structured
   record: name, brand, category, condition, an estimated price and how confident it is in
   that estimate.
3. **Optionally** — the estimate is checked against live web results, and the sources come
   back as clickable citations. A claim with no source fails validation, so the evidence
   trail is real rather than decorative.
4. **The verdict** — the backend computes what this price does to your month and returns
   one of five bands, from *easy* to *out of reach*, with the arithmetic behind it and one
   concrete next step.
5. **After** — the scan is saved. The history is grouped by category and rendered as
   statistics: where the money goes, what you talked yourself out of, how the verdicts
   trend.

The important part of step 4: **every number is computed in Python from your own figures,
and the model is handed those numbers and asked only for the words.** A model allowed to
do the arithmetic will be confidently wrong about a month count, and a confidently wrong
month count is the one thing a money tool cannot produce.

## Stack

| Layer | Choice |
|---|---|
| UI | React 19, TypeScript 5.9 (strict), Vite 8, Tailwind CSS v4 |
| Components | Untitled UI on react-aria-components — accessible primitives, design tokens for light and dark |
| API | FastAPI 0.140, Pydantic v2, uvicorn |
| Vision + reasoning | Anthropic `claude-sonnet-5` → `claude-haiku-4-5` → OpenAI `gpt-4o`, structured output validated against a Pydantic model |
| Price evidence | Tavily retrieval, citations enforced by schema |
| Storage | `localStorage` (profile, validated with Zod on every read) · SQLite (scan history) |
| Charts | Recharts, coloured from the running design tokens |
| Dev loop | One command starts both servers over LAN HTTPS and prints a QR code for the phone |

Python 3.14, Node 20+. No router, no state library, no ORM — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-is-deliberately-absent).

LAN HTTPS is not a nicety: `navigator.mediaDevices` does not exist on a plain-http LAN
address, so without it the camera cannot be tested on a real phone at all.

## Quick start

```bash
cp backend/.env.example backend/.env    # then paste the keys listed in it
make install                            # npm packages + Python venv
make dev                                # both servers, LAN URL, QR code
```

| | |
|---|---|
| `https://localhost:5173` | the app |
| `https://<lan-ip>:5173` | the same app from any phone on the Wi-Fi — scan the QR |
| `http://localhost:8000/api/health` | backend status; `/docs` for the OpenAPI page |

`ANTHROPIC_API_KEY` is required — without it there is nothing to read the photo. The other
two are optional and degrade to one named, visible failure instead of a dead app:
`OPENAI_API_KEY` is the third link in the model chain, and without `TAVILY_API_KEY` the
price-evidence panel reports `search_key_missing` and says so on screen.

`make` on its own lists the other entry points (`web`, `api`, `qr`, `build`, `typecheck`,
`clean`). Phone cannot reach it → [scripts/README.md](scripts/README.md).

## API

Every route lives under `/api`, which Vite proxies to FastAPI — so no IP is ever hardcoded
and the same build works on localhost, on the LAN and behind a tunnel.

| Route | Does |
|---|---|
| `POST /api/vision/extract` | photo → `ItemReading`. Registered shapes: `GET /api/vision/schemas` |
| `POST /api/vision/detect` | labelled regions, boxes normalised to `[0..1]` for an overlay |
| `POST /api/affordability/assess` | `ItemReading` + profile → verdict, arithmetic, advice |
| `POST /api/search` · `/api/search/ground` | retrieval, then an answer whose every claim carries a source index |
| `/api/items` | scan history — `POST`, `GET`, `DELETE`, namespaced by collection |
| `GET /api/health` | 503 and the missing variable's **name** when configuration is incomplete |

## Layout

```
src/
  App.tsx              the screen
  types/contract.ts    the only frontend/backend seam — mirrors the Pydantic models
  lib/
    camera/            capture, downscale, ten named permission failures
    vision/            client for the two vision routes, plus the box overlay
    search/            grounded answers and the citation list
    store/             profile in localStorage, history through the API
    dataviz/           stat tiles, sparklines, four charts
    ui-states/         the async-state union every request goes through
  components/          Untitled UI primitives
  styles/              design tokens; light and dark
backend/
  main.py              app shell, CORS for private LAN ranges, /api/health
  settings.py          the one place that loads .env; port, origins, env contract
  vision_router.py     ItemReading and the extract route
  affordability.py     the formula and the advice call
  search_router.py     retrieval; ground.py enforces the citations
  store_router.py      SQLite-backed items; db.py owns the connection
  provider.py          model registry and the fallback chain
  clients.py           one function per provider SDK
  errors.py            named failures → distinct HTTP statuses
  schema.py            Pydantic JSON Schema → OpenAI's strict subset
```

## Failure behaviour

There are no mocks, no fixtures and no demo mode anywhere in this repository. When
something is not configured or a provider is down, the app says which thing and why:

| Situation | Status | `code` |
|---|---|---|
| No key set, or the provider rejected it | 503 | `missing_credentials` |
| Every model rate-limited or down | 502 | `provider_unavailable` (+ `Retry-After`) |
| No model answered inside 60s | 504 | `upstream_timeout` |
| Model answered, the schema rejected it | 500 | `parse_failure` |
| Expenses at or above income — no disposable income to reason about | 422 | `impossible_budget` |

A visible, honest failure survives scrutiny. A fake success does not, and it takes the
rest of the demo with it when someone asks one question about it.
