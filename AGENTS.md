# Agent reference — fintech-helper

Canonical brief for any AI agent working on this project.

## What this is

A hackathon build (Cursor Calgary) that helps gig/daily-pay workers understand the cost of 
purchases in the context of their actual income and cash flow.

**User journey:** pick a worker (real CSV data for 220 people) → photograph an object → 
vision model extracts item details → backend computes affordability verdict (Python, not AI) 
→ model writes human-readable explanation → save scan to history.

**The core principle:** every number in the result is computed deterministically from the 
user's own data, in Python. The model only supplies words and reads photos. This makes the 
advice auditable and honest.

## What works now

- **Backend:** `affordability.py` (verdict formula), `vision_router.py` (photo → `ItemReading`), 
  `search_router.py` (price grounding), `store_router.py` (scan history)
- **Frontend:** all lib modules (`camera`, `vision`, `dataviz`, `store`, `search`, `ui-states`) 
  are built and typechecked
- **Data:** 220 workers, 3 months of daily earnings/expenses/cashflow, precomputed in `engine/`
- **Stack:** React 19 + TypeScript (strict), FastAPI, Claude vision + reasoning models, SQLite

## What's being built

- **Dev A:** `GET /api/profile/{worker_id}` endpoint (derives `Profile` from CSVs)
- **Dev B:** `src/App.tsx` full rewrite (camera → vision extract → affordability assess pipeline)
- **Dev C:** weather badge + EWA fee stat (display-only reads from the profile endpoint)

See `execution.md` for the parallel implementation plan.

## Key rules

- **Python computes every number.** The model never does arithmetic. If it tries, the result 
  fails validation and returns `parse_failure`.
- **English only** in code, comments, and files (reply to users in their language).
- **Fail loudly with named codes.** No mocks, no demo mode, no silent degradation. If 
  something is not configured or fails, the app says which thing and why.
- **Read before claiming.** Every architectural decision has a doc source. Point at it if 
  you reference a claim.
- **`contract.ts` is frozen:** one writer only (backend), additive changes only, never rename 
  or remove fields.

## Where to look

| Question | File |
|---|---|
| What does the app do? | `README.md` |
| How are pieces wired together? | `docs/ARCHITECTURE.md` |
| Vision model best practices + foundation | `docs/vision-best-practices.md` |
| What's the implementation plan? | `execution.md` |
| Data-grounded roadmap + scope cuts | `docs/roadmap.md` |

## Common tasks

**"I need to understand the affordability formula"** →
Read `backend/affordability.py`'s header comment and `compute()` function (lines 1–30, 
60–90). The verdict bands are documented inline.

**"I'm debugging why a vision call failed"** →
Check `backend/provider.py` (model chain: Sonnet 5 → Haiku 4.5 → GPT-4o), 
`backend/errors.py` (named failure codes), and `backend/schema.py` (Pydantic validators).

**"I'm adding a new backend route"** →
Follow the pattern in `affordability.py` (imports, exception handling, return shape). 
Add the corresponding TypeScript type to `src/types/contract.ts`.

**"The frontend is blank or erroring"** →
Check `src/lib/ui-states/` (async state union) and `AsyncBoundary.tsx` — every async 
path must go through this to render correctly (idle → loading → error/empty/success).
