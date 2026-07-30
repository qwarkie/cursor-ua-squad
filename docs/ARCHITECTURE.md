# Architecture

How the pieces fit, why the seams are where they are, and what was left out on purpose.
Start at [../README.md](../README.md) for what the app does.

## The loop

```
 phone camera
      │  Blob, downscaled to a 1024px long edge before it leaves the device
      ▼
 POST /api/vision/extract ────────────► ItemReading
      │                                 name · brand · category · condition
      │                                 estimated_price · price_confidence · price_basis
      │
      ├─ optional ─► POST /api/search ─► /api/search/ground ─► claims + sources
      │              live market price, every claim carrying a source index
      ▼
 POST /api/affordability/assess ──────► { math, advice }
      │              math    computed in Python from the user's own figures
      │              advice  written by the model, over those figures
      ▼
 POST /api/items  (collection: scans) ─► history on disk
      │
      ▼
 stat tiles · category breakdown · verdict trend
```

Each arrow is a typed boundary. The frontend never reaches past `/api`, and the backend
never learns anything about the UI.

## The three territories

The codebase is split along the data flow rather than by feature, so that two people
working at once do not edit the same file:

| Territory | Owns | From → to |
|---|---|---|
| Capture | `src/lib/camera/**`, `src/lib/vision/**` | device → typed payload |
| Intelligence | `backend/**` | payload → typed result |
| Surface | `src/App.tsx`, `src/components/**`, `src/styles/**` | typed result → pixels |

A feature-based split fails here: almost any feature touches the capture component, a
backend route and the global styles at once, which is three collisions per feature.

### The one shared file

`src/types/contract.ts` is the only file all three territories read. It mirrors the
Pydantic models by hand — there is no generator — and it has **one writer**: whoever owns
the backend. Everything else is built against those types instead of against each other.

Changing a field there breaks somebody's screen mid-build, so the rule after the first
version is: add a new optional field, never rename or remove an existing one.

## Why the arithmetic is not the model's job

`backend/affordability.py` is deliberately two halves.

`compute()` is pure arithmetic on the request. It is the only source of every number the
UI displays:

```
disposable = income − expenses                 capacity  = disposable × commit_share
buffer     = expenses × emergency_months       spendable = max(0, savings − buffer)
months     = max(0, price − spendable) / capacity
work_hours = price / (income / 173.33)         # 40h × 52 weeks / 12 months
```

The verdict is a band on `price / disposable`:

| Band | Meaning |
|---|---|
| ≤ 0.10 | `easy` — inside the noise of one month |
| ≤ 0.35 | `affordable` |
| ≤ 1.00 | `stretch` — one month of everything spare |
| ≤ 3.00 | `plan_it` — a savings plan, and the endpoint says how many months |
| above | `out_of_reach` at the current commitment rate |

Two flags sit alongside the bands, because "can I afford it" and "should I pay cash today"
are different questions: `payable_from_savings`, and `breaks_emergency_fund` when paying
cash would eat into the buffer.

The model then receives those computed figures in the prompt and returns a flat
`Advice` — headline, reasoning, one action, a tradeoff, alternatives, a risk level. It is
told to quote the numbers and never to recompute them. If it returns a shape that does not
validate, the request fails with `parse_failure` rather than passing a plausible-looking
guess to the screen.

This is also what makes the result auditable: every figure in the UI can be traced to one
line of Python and the user's own three inputs.

## State and failure

Every asynchronous path goes through one discriminated union:

```
idle │ loading │ error │ empty │ unsupported │ success
```

The boundary component requires **all** branches as props, so a forgotten error state is a
compile error rather than a blank panel at the worst possible moment. `unsupported` is a
first-class state, not a crash: no camera, an insecure origin, a denied permission, a
browser with no `ResizeObserver` — each renders what is missing and what to do about it.

Named failures cross the wire as `{code, message}` with a distinct HTTP status, so the UI
can render a different screen for "no API key" than for "rate limited" than for "the model
returned garbage". The table is in the [README](../README.md#failure-behaviour).

The model chain is `claude-sonnet-5 → claude-haiku-4-5 → gpt-4o`. A 429 reads the
provider's own `retry-after`, puts that one model on cooldown for exactly that long and
moves down the chain; a rejected key or an unsupported schema stops the chain immediately,
because those fail identically on the next model and retrying only spends the user's time.
When every model is exhausted the request fails. Nothing synthetic is ever returned.

## Storage

Two tiers, chosen by what the data has to survive:

- **The profile** lives in `localStorage`, validated with Zod on every read. A payload
  written by an older build surfaces as an error state naming the failing field, not as
  `undefined` crashing a child component. A one-byte probe on mount detects Safari Private
  Browsing, where the quota is zero and the first write throws — the app then keeps working
  in memory and says plainly that nothing is being persisted.
- **The history** goes to SQLite through `/api/items`: one table, a JSON payload column and
  `collection` as the namespace. Mutations re-read from the server rather than patching a
  local copy, so what is on screen is what is actually on disk. A refresh mid-demo does not
  blank the list, because the loading and error states carry the last list the server
  actually confirmed.

The 5 MB origin quota is why photographs never go into `localStorage`.

## Dev environment

`make dev` runs both servers and prints a LAN URL plus a QR code. Vite serves HTTPS with a
self-signed certificate and proxies `/api` to FastAPI, which means:

- the phone reaches a **secure origin**, without which `getUserMedia` does not exist;
- no LAN IP is ever compiled into the frontend;
- CORS is matched by regex across every private range, including phone hotspots and
  `*.local`, so a changed network does not become a debugging session.

The certificate is signed for `localhost` only, so the phone will warn once about it. That
warning is expected and is not a sign of a broken setup.

## Deliberately minimal

No router, no state-management library, no component library beyond the vendored
primitives, no ORM, no tests, no CI, no container files.

A router for one screen, a store for a handful of variables, and an ORM for one table 
each cost more than they return at this scale. Unused infrastructure reads as noise and 
obscures the actual structure.

Mocks, fixtures, and demo-mode flags are absent by design: this app fails loudly and names 
the specific cause, so the behavior stays honest under scrutiny. That's the only version 
that survives a user asking "wait, why did it say that?"
