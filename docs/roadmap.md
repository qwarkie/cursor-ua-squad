# "Worth It" — Roadmap v2 (data-grounded)

Supersedes the original 2-hour MVP draft below. Two things changed since that draft:

1. **The scaffold is further along than the draft assumed.** `backend/affordability.py`,
   `vision_router.py`, `search_router.py`, `store_router.py` are all wired into `main.py` and
   working — `/api/health` is the only endpoint actually exercised by the frontend so far
   (`src/App.tsx` is still the health-check screen). The house style is already "Python
   computes every number, the model only writes the words" (see `affordability.py`'s own
   header comment) — that's exactly the principle we independently arrived at for the
   afford-check. No conflict, just reuse it.
2. **We have real data**: `data/*.csv` — 220 gig/daily-pay workers, 3 months of daily
   earnings, their recurring bills, EWA (paycheck-advance) usage, and weekly cashflow
   summaries the organizers themselves precomputed (`buffer_days_estimate`,
   `negative_balance_flag`). A prototype engine (`engine/engine.py`) already reads these
   and is verified against all 220 workers — see "What's already proven" below.

## The one architectural change: Profile stops being typed, it's derived

`backend/affordability.py`'s `Profile` model (`monthly_income`, `monthly_expenses`,
`savings`, `commit_share`, `emergency_months`) currently expects manual entry. Replace
manual entry with a **new `GET /api/profile/{worker_id}`** that builds the same `Profile`
shape from the CSVs:

| Profile field | Derived from |
|---|---|
| `monthly_income` | sum of `net_pay_cad` over the trailing 30 calendar days, `daily_earnings.csv` |
| `monthly_expenses` | sum of **essential** (`essential=1`) rows in `recurring_obligations.csv`, normalized to monthly (biweekly × 30.44/14) |
| `savings` | latest `ending_balance_cad` for that worker, `weekly_cashflow_summary.csv` |
| `commit_share`, `emergency_months` | keep the existing defaults (0.30, 1.0); optionally scale `emergency_months` up for workers with high `income_volatility` (`workers.csv`) — nice-to-have, not required |

Everything downstream — `compute()`'s verdict bands, `AssessResponse`, the frontend's
`AffordabilityMath` type — is **unchanged**. This is the whole point: real income
volatility flows into an existing, already-tested formula instead of a demo-time guess
typed into a form. That's a stronger Technical Execution story than adding a parallel
computation path.

Demo profile picker: 3 hardcoded `worker_id`s instead of a free-text picker —
- `W-0001` — moving helper, Calgary, severe rent burden, currently `partly_cloudy`
- `W-0003` — security guard, Red Deer, healthier margin, currently `sunny`
- `W-0159` — the one worker in the dataset currently in deficit (`rainy`/`overcast` band)

## Bonus surfaces (same data, no new pipeline)

Both of these read fields that are either already computed by the organizers' CSVs or by
`engine/engine.py`'s prototype logic — they are display-only, no new LLM calls needed.

**Financial weather widget** — a badge next to the afford verdict. Prefer the
organizers' own `buffer_days_estimate` / `negative_balance_flag` from
`weekly_cashflow_summary.csv` as the primary signal (don't recompute what the dataset
already computed), cross-checked against the trailing-7-vs-prior-7 `true_take_home`
trend from `engine.py` for the "improving vs softening" distinction. 5 states: sunny /
partly_cloudy / overcast / rainy / storm. Verified reachable across the population
(sunny 121, partly_cloudy 76, overcast 22, rainy 1 in the current engine prototype;
storm needs deficit + recent EWA fee, rare but logically correct).

**EWA fee-trap stat** — one line, `src/lib/dataviz/Stat.tsx` already exists for exactly
this: *"You've paid $X in fees this month renting your own paycheck early."* Sum of
`fee_cad` in `earned_wage_advances.csv` over the trailing 30 days for the selected
worker. This is the most novel, least-typical-budget-app thing in the whole build — no
mainstream app surfaces this, and it directly answers the prompt's "beyond typical money
in/money out." Push for this over micro-goals if time is short — it's cheaper (pure
arithmetic + existing Stat component, no new UI pattern) and scores higher on Innovation.

**Micro-goals** — de-prioritized. Lowest marginal rubric value (most "seen before" of
the four original ideas) and would need a new UI pattern + new persisted state
(`store_router.py`'s `/api/items` could hold it, but it's still net-new screen work).
Cut first if behind schedule.

## Updated critical path

Given the scaffold already exists, the work left is: wire one derived-profile endpoint,
wire `App.tsx` to the real pipeline (camera → vision extract → affordability assess),
and add the two bonus display reads. Rough shape, not a hard clock — adjust to time
remaining:

1. `backend/profile_router.py` (new) — `GET /api/profile/{worker_id}` reading the CSVs
   directly (or from `engine/precomputed/*.json` if we keep that cache), returning
   `Profile` + the two bonus fields (weather state, ewa_fee_30d).
2. `src/App.tsx` — replace the health screen with: worker picker (3 hardcoded ids) →
   `CameraCapture` → `useVision` (`/api/vision/extract`, `schema_name: 'item'`) →
   `/api/affordability/assess` with the fetched `Profile` → result card using
   `AssessResponse.math` + `AssessResponse.advice`.
3. Weather badge + EWA-fee stat rendered on the same result screen, both reading fields
   already present on the `/api/profile/{worker_id}` response — no extra round-trip.
4. `POST /api/items` (already wired) to persist each scan as history, if time allows —
   this is free, `store_router.py` needs no changes.
5. README pass: name-check the prompt's own language ("beyond typical money in/money
   out") explicitly, since Problem-Solution Fit is scored against the prompt text.

## What's already proven (don't re-verify, reuse)

`engine/engine.py` (stdlib-only, no pandas needed) is CLI-verified against the real CSVs:
- `build --all` writes all 220 workers' daily true-take-home series in under a second
- `weather --worker <id>` reaches all non-storm states across the population
- `afford --worker <id> --amount <n>` and `goal --worker <id> --target <n> --saved <n>`
  both produce sane, real numbers off the actual data (e.g. W-0001: "$45 = about half a
  slow day", 7-day buffer $291)

Treat this as the reference implementation for the profile-derivation math above, not as
a second service to run — the FastAPI backend should absorb the CSV-reading logic
directly (or shell out to `engine/precomputed/*.json`) rather than running two backends.

## Cut list (unchanged from the original draft, still applies)

Auth, database beyond the existing `store_router.py`, forecasting, price-API accuracy
beyond `search_router.py`'s existing grounding, offline support, gamification,
micro-goals (see above). All Phase 2+.

---

## Original 2-Hour MVP Plan (superseded, kept for reference)

The goal is a working demo, not a product. Cut everything not on the critical path: no
auth, no database, no accounts. One screen, one API call, localStorage for state.

### Scope (what the demo does)

1. User types their **daily earnings** once (saved in localStorage). — *superseded: now
   derived from the CSVs via `/api/profile/{worker_id}`.*
2. User **uploads/snaps a photo** of an object. — *unchanged, `CameraCapture` already exists.*
3. One backend call to a **vision LLM** that returns item name, estimated price, and a
   short affordability plan in a single JSON response. — *superseded: the plan/verdict
   is computed in Python (`affordability.py::compute`), the model only writes the words.*
4. Show a result card: item, price, verdict, days-to-afford, one trade-off line. — *unchanged.*

### Stack (minimal) — unchanged, already in place

- **Frontend:** Vite + React + TypeScript (already scaffolded, `src/lib/*` modules wired but unmounted)
- **Backend:** Python FastAPI (already scaffolded, routers wired in `main.py`)
- **State:** localStorage for history is available (`src/lib/store/useLocal.ts`,
  `useItems.ts`) — profile itself no longer needs manual entry or localStorage.
