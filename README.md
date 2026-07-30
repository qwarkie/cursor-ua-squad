# fintech-helper

![fintech-helper](./cover.png)

Tell it what you earn and what it goes on, then point a phone camera at something in a
shop. It answers what that thing costs **you**: the share of your spare money, the hours of
work behind it, and how many weeks of saving it adds.

## The problem

A price tag is a number without a denominator. `$329` means something entirely different to
two people in the same queue, and neither of them can work out which one they are in the
four seconds before they tap the card. Budgeting apps answer afterwards, from bank
statements, which is the one moment the answer cannot change the outcome.

This app answers it in front of the shelf.

## How it works

**1. Say what the month looks like.** A chat, typed or spoken. "I take home 4200, rent is
1500, groceries about 600, and I have 800 saved." A model pulls the figures out of that and
keeps asking for what is still missing. It is instructed not to estimate a figure you did
not give, and not to do any arithmetic on the ones you did.

**2. See where the salary goes.** Take home, committed, left over, and a donut of the split.
The categories are a closed list, so the chart does not fragment into singletons.

**3. Photograph the thing you want.** Camera, or a photo from the library. A vision model
reads it into a record: name, brand, category, condition, an estimated price, how confident
it is in that price, and what the estimate is based on. If it cannot price what it sees, it
returns nothing rather than guessing, and the app asks you to type the price.

**4. Get the verdict and the plan.** One of five bands from *easy* to *out of reach*, the
arithmetic behind it, and a saving plan: an amount per week, the number of weeks, and the
shortfall it covers.

### Every number is computed, not generated

The model's only job is words. `compute()` in `backend/affordability.py` is pure arithmetic
on your own figures and is the single source of every figure on screen:

```
disposable = income - expenses          capacity  = disposable x commit_share (30%)
buffer     = expenses x 1 month         spendable = max(0, savings - buffer)
shortfall  = max(0, price - spendable)  weekly    = capacity / 4.33
weeks      = ceil(shortfall / weekly)   work_hours = price / (income / 173.33)

verdict = price / disposable   <=0.10 easy · <=0.35 affordable · <=1.0 stretch
                               <=3.0 plan_it · above that out_of_reach
```

The model receives those results and is told to quote them. It is told this because the
first version was allowed to work out the plan itself and produced "set aside 522 until you
reach 329": it anchored on the monthly capacity instead of the target. A money tool can be
wrong, but it cannot be confidently wrong about a month count.

## Stack

| Layer | Choice |
|---|---|
| UI | React 19, TypeScript 5.9 (strict), Vite 8, Tailwind CSS v4 |
| Components | Untitled UI on react-aria-components, styled from design tokens |
| API | FastAPI 0.140, Pydantic v2, uvicorn, Python 3.14 |
| Vision and reasoning | Anthropic `claude-sonnet-5` → `claude-haiku-4-5` → OpenAI `gpt-4o`, structured output validated against a Pydantic model |
| Voice input | Groq `whisper-large-v3-turbo`, transcribed server-side so the key never reaches the browser |
| Storage | `localStorage`, validated with Zod on every read |
| Charts | Recharts, coloured from the running design tokens |
| Dev loop | One command starts both servers over LAN HTTPS and prints a QR code for the phone |

The app ships locked to the dark theme (`class="dark-mode"` on `<html>`); the tokens carry
both. No router, no state library, no ORM, no tests, no CI, no containers, and nothing is
mocked anywhere. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deliberately-minimal).

LAN HTTPS is not a nicety. `navigator.mediaDevices` does not exist on a plain-http LAN
address, so without it neither the camera nor the microphone can be tested on a real phone.

## Quick start

```bash
cp backend/.env.example backend/.env    # then paste the keys listed in it
make install                            # npm packages + Python venv
make dev                                # both servers, LAN URL, QR code
```

| | |
|---|---|
| `https://localhost:5173` | the app (Vite takes the next free port if 5173 is busy) |
| `https://<lan-ip>:5173` | the same app from any phone on the Wi-Fi, via the QR code |
| `http://localhost:8000/api/health` | backend status; `/docs` for the OpenAPI page |

**Keys.** `ANTHROPIC_API_KEY` is required: without it nothing reads your figures or the
photo. The rest are optional, and each one missing costs exactly one feature, loudly:

| Key | Without it |
|---|---|
| `OPENAI_API_KEY` | the model chain loses its third link and stops after the two Anthropic models |
| `GROQ_API_KEY` | the mic button goes dark and says voice input is unconfigured; typing still works |
| `TAVILY_API_KEY` | nothing in the app changes, see *Not wired up* below |

`make` on its own lists the other entry points (`web`, `api`, `qr`, `build`, `typecheck`,
`clean`). Phone cannot reach it → [scripts/README.md](scripts/README.md).

## API

Every route lives under `/api`, which Vite proxies to FastAPI, so no IP is ever hardcoded
and the same build works on localhost, on the LAN and behind a tunnel.

| Route | Does | Used by the app |
|---|---|---|
| `POST /api/budget/breakdown` | chat transcript → income, savings, categories, chart-ready split | yes |
| `POST /api/voice/transcribe` | recorded clip → text, via Groq | yes |
| `GET /api/voice/status` | whether voice is configured, so the mic can say why it is off | yes |
| `POST /api/vision/extract` | photo → `ItemReading`. Registered shapes: `GET /api/vision/schemas` | yes |
| `POST /api/affordability/assess` | reading + profile → verdict, arithmetic, saving plan | yes |
| `GET /api/health` | 503 and the missing variable's **name** when configuration is incomplete | yes |
| `POST /api/vision/detect` | labelled regions, boxes normalised to `[0..1]` | no |
| `POST /api/search` · `/api/search/ground` | retrieval, then an answer whose every claim carries a source index | no |
| `/api/items` | generic SQLite-backed rows, namespaced by collection | no |

## Not wired up

Mounted and working if called directly, but no screen calls them. Listed here so the
feature list above stays honest:

- **Price evidence from the live web.** `search_router.py` plus `src/lib/search/` grounds a
  claim against Tavily results and rejects any claim without a source index. Nothing in the
  UI asks it, so the price you see is the model's estimate or the one you typed.
- **Scan history and statistics.** `store_router.py` keeps rows in SQLite and
  `ScanRecord` in the contract describes the shape a saved scan would take. Nothing saves
  one. Verdicts are not kept: reload and the last one is gone.
- **Bounding boxes on the photo.** `/api/vision/detect` and `BoxOverlay` exist; the scan
  panel shows the photo plain.

What *is* persisted: the conversation and the latest budget split, in `localStorage`. A
reload keeps both. A payload written by an older build surfaces as a named error state
rather than as `undefined` inside a component.

## Layout

```
src/
  App.tsx                    state, and the single column everything stacks in
  types/contract.ts          the one frontend/backend seam; mirrors the Pydantic models
  lib/records.ts             Zod schemas for anything persisted
  components/app/
    ChatPanel.tsx            transcript, composer, suggestions
    MicButton.tsx            record, transcribe, and every reason it can refuse
    BreakdownPanel.tsx       the three figures and the donut
    ScanPanel.tsx            viewfinder, upload, the reading, the price box
    VerdictCard.tsx          band, arithmetic, saving plan, alternatives
  components/base|foundations  Untitled UI primitives, vendored
  lib/
    camera/                  getUserMedia lifecycle and ten named failure kinds
    vision/                  client for the vision routes
    mic/                     MediaRecorder capture, container choice, level meter
    store/                   typed localStorage with schema validation on read
    dataviz/                 stat tiles and charts, themed from the tokens
    ui-states/               the async-state union every request goes through
    search/                  grounded answers and citations (not wired up)
  styles/                    design tokens, light and dark
backend/
  main.py                    app shell, CORS for private LAN ranges, /api/health
  settings.py                the one place that loads .env; port, origins, env contract
  budget.py                  chat → figures, and the split arithmetic
  voice.py                   Groq Whisper upload
  vision_router.py           ItemReading and the extract route; detect.py alongside
  affordability.py           compute() and the advice call
  provider.py                model registry and the fallback chain; clients.py per SDK
  errors.py                  named failures → distinct HTTP statuses
  schema.py                  Pydantic JSON Schema → OpenAI's strict subset
  search_router.py           retrieval; ground.py enforces the citations (not wired up)
  store_router.py            SQLite rows; db.py owns the connection (not wired up)
```

## Failure behaviour

No mocks, no fixtures, no demo mode anywhere in this repository. When something is not
configured or a provider is down, the app names it:

| Situation | Status | `code` |
|---|---|---|
| No key set, or the provider rejected it | 503 | `missing_credentials` |
| Every model rate-limited or down | 502 | `provider_unavailable` (+ `Retry-After`) |
| No model answered inside 60s | 504 | `upstream_timeout` |
| Model answered, the schema rejected it | 500 | `parse_failure` |
| Expenses at or above income, so there is no spare money to measure against | 422 | `impossible_budget` |
| Category names and amounts came back at different lengths | 502 | `inconsistent_budget` |
| `GROQ_API_KEY` missing or rejected | 503 | `voice_key_missing` |
| Recorded clip empty, or over 8 MB | 422 / 413 | `empty_clip` / `clip_too_large` |
| Groq refused the clip, or was unreachable | 502 | `transcription_rejected` / `transcription_unreachable` |

In the browser, every request goes through one discriminated union of six states, and the
boundary component requires all of them, so a forgotten error branch is a compile error
rather than a blank panel. A missing camera, an insecure origin and a denied permission are
three different messages, each saying what still works without it.

A visible failure for an honest reason survives scrutiny. A fake success does not.
