# "Worth It" — 3-way parallel implementation plan

## Context

Hackathon build, ~2hr window, AI-judged on 6 passes (repo structure, code quality,
innovation, visual UX, pool comparison, synthesis). The scaffold is already further along
than a fresh-start plan would assume: `backend/affordability.py`, `vision_router.py`,
`search_router.py`, `store_router.py` are wired and working; `src/lib/camera`, `src/lib/vision`,
`src/lib/dataviz`, `src/lib/store`, `src/lib/search`, `src/lib/ui-states` are all built,
typechecked, unmounted. `src/App.tsx` is still just the health-check screen. The one real
architectural gap is: `Profile` (income/expenses/savings) is manually-typed today, but real
CSV data (220 workers, 3 months of daily earnings, bills, EWA advances, weekly cashflow) exists
to derive it instead. That's the single new backend endpoint everything else hangs off.

**Already done (this session, before this plan), do not re-do:**
- `engine/engine.py`'s `DATA_DIR` bug fixed — `hackaton_data/` renamed to `data/` (`git mv`),
  verified with `python3 engine.py weather --worker W-0001` → real JSON.
- `make install` run — `node_modules/` and `backend/.venv/` exist.
- `backend/.env` copied from `.env.example` — **still needs a real `ANTHROPIC_API_KEY`
  pasted in before `/api/health` will return `200`.** This is a 1-person, 30-second task,
  not part of the 3-way split below — whoever has the key should do it first.
- `engine/precomputed/*.json` regenerated for all 220 workers (`python3 engine.py build --all`).
  Confirmed: W-0001 = `partly_cloudy`, W-0003 = `sunny`, W-0159 = deficit (`rainy`), matching
  the hand-off's picks for the 3 hardcoded demo workers.

**Goal of this plan:** split the remaining critical path three ways so all three people can
work concurrently with minimal file collisions, using a **contract-first, stub-then-swap**
pattern so frontend work never blocks on the backend endpoint finishing first.

---

## The one shared step, before splitting (~5–10 min, whoever is fastest to type)

Add these types to `src/types/contract.ts` (the project's one frozen contract file — "one
writer only," per its own header comment — so whoever does this pushes/shares it immediately,
then the 3 people build against it without waiting on each other):

```ts
/** GET /api/profile/{worker_id} — derives Profile from the CSVs instead of manual entry. */
export interface WeatherBadge {
  /** 5-state read, computed server-side. Mirrors engine.py's compute_weather() states. */
  state: 'sunny' | 'partly_cloudy' | 'overcast' | 'rainy' | 'storm';
  reason: string;
  buffer_days_estimate: number;   // weekly_cashflow_summary.csv's own precomputed field
  negative_balance_flag: boolean;
  as_of: string;                  // ISO date
}

export interface FeeTrap {
  trailing_30d_fees_cad: number;
  trailing_30d_advance_count: number;
}

export interface ProfileResponse {
  worker_id: string;
  profile: Profile;   // reuses the existing Profile interface, unchanged
  weather: WeatherBadge;
  fee_trap: FeeTrap;
}
```

This is additive only (new interfaces, nothing renamed/removed), so it doesn't violate the
file's frozen-at-T+8 rule. Once this lands, all three workstreams below can start immediately.

---

## Dev A — Backend: `GET /api/profile/{worker_id}`

**Owns:** `backend/profile_router.py` (new), `backend/main.py` (one import + one
`include_router` line), the contract addition above.

### What to build

New file `backend/profile_router.py`, modeled on the existing router style (see
`backend/affordability.py` for the dual-import pattern and `def` not `async def` convention —
this endpoint is pure CSV/file reads, no LLM call, so it stays fast and sync):

```python
try:
    from .affordability import Profile
except ImportError:
    from affordability import Profile
```

**Data sources** (all in `data/`, sibling to `backend/` and `engine/` — use the same
`os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))` pattern
`engine/engine.py` already uses):

| Output field | Source | Logic |
|---|---|---|
| `profile.monthly_income` | `daily_earnings.csv` | Sum `net_pay_cad` for this `worker_id` where `work_date` is in the trailing 30 calendar days, anchored at that worker's own latest `work_date` (not "today" — the dataset is historical). |
| `profile.monthly_expenses` | `recurring_obligations.csv` | Sum `amount_cad` for rows where `worker_id` matches and `essential == "1"`. Monthly-frequency rows add as-is; biweekly rows scale by `30.44/14`. (Exact same normalization `engine.py`'s `daily_essential_reserve()` uses, just monthly instead of $/day — reuse that logic, don't reinvent it.) |
| `profile.savings` | `weekly_cashflow_summary.csv` | `ending_balance_cad` from the row with the latest `week_start` for this `worker_id`. |
| `profile.currency` | constant | `"CAD"` |
| `profile.commit_share`, `profile.emergency_months` | — | Don't set them — `Profile`'s Pydantic defaults (0.30, 1.0) already apply. (Optional nice-to-have if time allows: scale `emergency_months` up for high `income_volatility` workers from `workers.csv` — explicitly marked optional in the roadmap, skip under time pressure.) |
| `weather.state` / `reason` | derived | See "Weather derivation" below — **this is the one place cleverness pays off for Innovation scoring.** |
| `weather.buffer_days_estimate`, `weather.negative_balance_flag` | `weekly_cashflow_summary.csv` | Same latest-week row as `savings` — free, no extra parsing pass. |
| `fee_trap.trailing_30d_fees_cad`, `fee_trap.trailing_30d_advance_count` | `earned_wage_advances.csv` | Sum/count `fee_cad` for this `worker_id` where `requested_at`'s date falls in the same trailing-30-day window used for `monthly_income` (same anchor date, for internal consistency). |

**Weather derivation — the nuance worth getting right:**
The roadmap explicitly says *prefer the organizers' own `buffer_days_estimate` /
`negative_balance_flag` over recomputing, cross-checked against the trailing-7-vs-prior-7
`true_take_home` trend from `engine.py` for the "improving vs softening" distinction.*
Concretely — and cheaply, since `engine/precomputed/{worker_id}.json` already exists on disk
with exactly the trend numbers needed, so this is a plain `json.load()`, not a recomputation:

1. Load `engine/precomputed/{worker_id}.json`, take the **last** entry in `series`. It already
   has `rolling7_sum_cad` and `prev7_sum_cad` computed.
2. Load the latest `weekly_cashflow_summary.csv` row for `negative_balance_flag` and
   `buffer_days_estimate` (primary signal, per the roadmap).
3. State logic (mirrors `engine.py`'s own `compute_weather()` bands, just fed by the two
   preferred primary fields instead of re-deriving them from scratch):
   - `negative_balance_flag == "1"` → `"storm"` if any of the last 3 `series` rows have a
     nonzero `ewa_fee_cad` (recent EWA activity), else `"rainy"`.
   - else `buffer_days_estimate < 3.5` (half a week) → `"overcast"`.
   - else `rolling7_sum_cad > prev7_sum_cad` → `"sunny"`, else → `"partly_cloudy"`.
4. `reason`: one short human sentence, same style as `engine.py`'s own (e.g. `"%.1f days of
   buffer, trending %s"`).

This keeps "Python computes every number" (the house style from `affordability.py`'s header)
intact for the weather badge too — Dev C (frontend) only renders `weather.state`, never
re-derives it.

**Router wiring** (`backend/main.py`):
```python
from profile_router import profile_router  # noqa: E402
...
app.include_router(profile_router)  # /api/profile/{worker_id}
```
(Match the existing import style — `# noqa: E402` comment, placed with the other router
imports below the `settings` import per the existing comment there.)

**Errors:** 404 (plain `HTTPException`, matching `store_router.py`'s convention for
non-LLM/DB-style lookups, not the `LLMError` envelope which is for the model-calling routers)
when `worker_id` has no `daily_earnings.csv` rows or no `weekly_cashflow_summary.csv` rows.

### Verification (Dev A)
```bash
cd backend && .venv/bin/python -m uvicorn main:app --reload &
curl -s localhost:8000/api/profile/W-0001 | python3 -m json.tool
curl -s localhost:8000/api/profile/W-0003 | python3 -m json.tool
curl -s localhost:8000/api/profile/W-0159 | python3 -m json.tool
```
Confirm: `monthly_income > 0` and roughly matches `daily_earnings.csv` eyeballed sums;
`weather.state` is `partly_cloudy` (W-0001), `sunny` (W-0003), and a deficit state
(`rainy`/`storm`) for W-0159 — matching what `engine.py weather --worker <id>` already printed
for W-0001/W-0003/W-0159 in this session. Also hit `curl localhost:8000/api/profile/W-9999`
and confirm a clean 404, not a 500.

---

## Dev B — Frontend: rewrite `src/App.tsx` (the main pipeline)

**Owns:** `src/App.tsx` (full rewrite), two new small files under `src/lib/`.

**Do not write bespoke fetch-client boilerplate** (unlike `visionClient.ts`/`searchHttp.ts`,
which predate this hook) — `src/lib/ui-states/useAsync.ts` + `fetchJson.ts` already give a
generic `useAsync(fn, opts)` returning the same `idle|loading|error|empty|unsupported|success`
union, with a typed `AppError` parsed from the backend's `{code,message}` envelope. Use that
directly for both new calls instead of duplicating ~150 lines of transport code per client.

### What to build

1. **Worker picker** — 3 buttons/cards for the hardcoded ids, each with a one-line human tag
   (pull the descriptive language straight from `docs/roadmap.md`'s own list so it's consistent
   with what Dev C will quote in the README):
   - `W-0001` — "Moving helper, Calgary — severe rent burden"
   - `W-0003` — "Security guard, Red Deer — healthy margin"
   - `W-0159` — "Currently in deficit"

   On pick, call:
   ```ts
   const profileAsync = useAsync((signal, workerId: string) =>
     fetchJson<ProfileResponse>(`/api/profile/${workerId}`, { signal }));
   ```

2. **Camera step** — once `profileAsync.state.status === 'success'`, mount
   `<CameraCapture onDone={handleShots} />` from `@/lib/camera` (props: `onDone: (shots) =>
   void|Promise<void>`; no other config needed for the MVP).

3. **Vision step** — in `handleShots`, take `shots[0].blob` and call
   `useVision<ItemReading>({ schemaName: 'item' }).extract(shot.blob)` from `@/lib/vision`
   (already built, calls `POST /api/vision/extract` with `schema_name: 'item'` per the frozen
   contract — no changes needed here, just wire it).

4. **Assess step** — once vision's `extraction` state is `ready`, call affordability with the
   fetched profile:
   ```ts
   const assessAsync = useAsync((signal, req: AssessRequest) =>
     fetchJson<AssessResponse>('/api/affordability/assess', {
       method: 'POST', body: JSON.stringify(req), signal,
     }));
   // req = { profile: profileAsync.state.data.profile, item_name: reading.name,
   //          category: reading.category, price: reading.estimated_price,
   //          price_basis: reading.price_basis }
   ```

5. **Result card** — render `AssessResponse.math` + `.advice`: item name/price/category, a
   verdict badge (map `Verdict` → `Badge` color variant from
   `src/components/base/badges/badge-groups.tsx` — e.g. `easy`/`affordable` → success,
   `stretch`/`plan_it` → warning, `out_of_reach` → error), the math fields (`work_hours`,
   `months_to_save`, `share_of_disposable`, etc.), and `advice.headline` / `.reasoning` /
   `.action` / `.tradeoff` / `.alternatives` / `.risk`.

6. **Leave two clearly marked slots** for Dev C, so there's no file-content collision, only an
   append:
   ```tsx
   {/* SLOT(dev-c): weather badge — profileAsync.state.data.weather */}
   {/* SLOT(dev-c): fee-trap stat — profileAsync.state.data.fee_trap */}
   {/* SLOT(dev-c): persist scan — call after assessAsync reaches 'success' */}
   ```

7. Use `AsyncBoundary` (`src/lib/ui-states/AsyncBoundary.tsx`) + `defaultSlots()` from
   `src/lib/ui-states/states.tsx` per async step, instead of hand-rolling loading/error markup —
   this is exactly what that module is for, and it's already typechecked and styled.

8. Delete the existing health-check body — per the roadmap, "this is entirely to be replaced."
   Keep the `p-safe` / token-based styling convention (`bg-secondary`, `border-secondary`, etc.
   — see `src/components/README.md` for the token vocabulary) so the new screen matches the
   one visual convention already established.

**Note on `commit_share`/`emergency_months`:** `AssessRequest.profile` is the whole `Profile`
object Dev A's endpoint returns — pass it through unchanged, don't reconstruct it field-by-field.

### Verification (Dev B)
```bash
npm run typecheck
```
Then, once Dev A's endpoint is live (or against a hardcoded literal matching `ProfileResponse`
in the meantime — see "Parallelism note" below), manually walk through all 3 workers in the
browser: pick a worker → take/upload a photo → confirm a verdict + advice renders with no
console errors.

---

## Dev C — Bonus surfaces, persistence, docs

**Owns:** small additions inside `src/App.tsx` (the 3 marked slots only — coordinate with Dev B
on merge order, this is the one place two people touch the same file), `src/lib/records.ts`
(new), `README.md`.

### What to build

1. **Weather badge** — a small component (or inline JSX) rendering `ProfileResponse.weather`.
   Since Dev A's endpoint already computes the final `state` string server-side, this is pure
   rendering: map `state` → an existing `Badge` color (`sunny`→success, `partly_cloudy`→gray,
   `overcast`→warning, `rainy`/`storm`→error) + a short icon/emoji, showing `reason` as a
   tooltip or subtext. No new data derivation needed — this is the whole point of Dev A having
   already done the math.

2. **EWA fee-trap stat** — no new component needed; `src/lib/dataviz/Stat.tsx` already exists
   for exactly this. In the slot Dev B left:
   ```tsx
   <Stat
     label="Renting your own paycheck early"
     value={profileAsync.state.data.fee_trap.trailing_30d_fees_cad}
     formatValue={(v) => `$${v.toFixed(2)}`}
     footnote={`${profileAsync.state.data.fee_trap.trailing_30d_advance_count} advances this month`}
   />
   ```
   This is explicitly called out in the roadmap as the single highest-leverage Innovation item
   — don't cut it under time pressure, and don't let it get deprioritized behind polish.

3. **`src/lib/records.ts`** (new, currently missing — `src/types/contract.ts`'s own comment
   references it but it doesn't exist yet) — a Zod schema mirroring `ScanRecord` exactly:
   ```ts
   import { z } from 'zod';
   export const ScanRecordSchema = z.object({
     item_name: z.string(),
     category: z.string(),
     price: z.number(),
     currency: z.string(),
     verdict: z.enum(['easy', 'affordable', 'stretch', 'plan_it', 'out_of_reach']),
     share_of_disposable: z.number(),
     work_hours: z.number(),
     months_to_save: z.number(),
     headline: z.string(),
     scanned_at: z.number(),
   });
   ```

4. **History persistence** — in the `assessAsync` success slot Dev B left, call:
   ```ts
   const { save } = useItems<ScanRecord>('scans', ScanRecordSchema);
   // on assessAsync success:
   save({
     item_name: res.item_name, category: res.category, price: res.price, currency: res.currency,
     verdict: res.math.verdict, share_of_disposable: res.math.share_of_disposable,
     work_hours: res.math.work_hours, months_to_save: res.math.months_to_save,
     headline: res.advice.headline, scanned_at: Date.now(),
   });
   ```
   `useItems` (from `@/lib/store`) already talks to the wired `POST /api/items` /
   `store_router.py` — no backend change needed, this is genuinely free per the roadmap.

5. **README pass** — add a section that explicitly quotes the hackathon prompt's own language
   (e.g. "beyond typical money in/money out") verbatim, since Problem-Solution Fit is scored
   against the prompt text. Map the EWA fee-trap stat and weather badge directly to that quoted
   phrase — these are the two features that go beyond a typical budget app's money-in/money-out
   framing, so naming that connection explicitly is free rubric points.

6. **Final end-to-end smoke test** (after A+B+C land): `make dev`, click through all 3 workers,
   confirm the weather badge and fee-trap stat render with real numbers, and confirm a scan
   round-trips: `curl 'localhost:8000/api/items?collection=scans'` shows the new row after a
   scan completes in the browser.

### Verification (Dev C)
```bash
npm run typecheck   # after adding src/lib/records.ts
```
Manual: complete one scan in the browser, then confirm via curl (above) that it persisted.
Read the README section aloud once — does it actually use the prompt's own words, not a
paraphrase?

---

## Parallelism note (how B and C avoid blocking on A)

Once the shared contract types land (the ~5–10 min step above), Dev B and Dev C can both code
against `ProfileResponse` immediately by hardcoding one literal object matching that exact shape
at the top of `App.tsx` in place of the real fetch call, e.g.:
```ts
const MOCK_PROFILE: ProfileResponse = { worker_id: 'W-0001', profile: {...}, weather: {...}, fee_trap: {...} };
```
Swap `MOCK_PROFILE` for `profileAsync.state.data` the moment Dev A's endpoint is confirmed
working (a 1-line change) — this is the standard contract-first/stub-then-swap pattern and
means all three people are productive from minute 10 onward instead of B/C waiting on A.

## Coordination point

`src/App.tsx` is touched by both Dev B (full rewrite) and Dev C (fills 3 marked slots). Sequence
it as: Dev B lands the rewrite with slots marked first (even mid-build, once the structure is
stable), Dev C's changes are then small, additive diffs inside those slots — low collision risk
if Dev B commits/shares early rather than holding the whole file until it's fully done.
