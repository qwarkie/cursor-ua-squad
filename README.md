# fintech-helper

Base for the salary-vs-object build: point the camera at a thing, get told whether this
salary can carry it. Nothing here is the product yet — it is the template plus the wired
capability modules, so the first line of feature code has somewhere to land.

## Run it

```bash
make install     # once
make dev         # both servers, LAN HTTPS, QR code for the phone
```

`https://localhost:5173` · `http://localhost:8000/api/health` · `/docs` for the API page.
Phone trouble → `scripts/README.md`. Keys are already in `backend/.env`.

## What is wired

| Route | From | Does |
|---|---|---|
| `POST /api/vision/extract` | `backend/vision_router.py` | photo → `ItemReading` (name, category, price estimate, confidence). `schema_name: 'item'` |
| `POST /api/vision/detect` | `backend/detect.py` | labelled boxes in `[0..1]`, for an overlay on the shot |
| `POST /api/affordability/assess` | `backend/affordability.py` | `ItemReading` + `Profile` → verdict. **Python does every number, the model only writes the words** |
| `POST /api/search` + `/ground` | `backend/search_router.py` | real market price with clickable citations (Tavily). A claim with no source fails validation |
| `/api/items` | `backend/store_router.py` | scan history on disk at `backend/data/store.db` |
| `GET /api/health` | `backend/main.py` | 503 + the missing key name when env is incomplete |

Frontend modules, all typechecking under strict, none mounted yet:

```
src/lib/ui-states/   every async path: idle|loading|error|empty|unsupported|success, exhaustive
src/lib/camera/      useCameraPhoto + CameraCapture, named permission failures, upload fallback
src/lib/vision/      useVision, BoxOverlay — the client for the two vision routes
src/lib/search/      useGroundedAnswer, Citations
src/lib/store/       useLocal (profile, survives refresh), useItems (history, survives the browser)
src/lib/dataviz/     Stat, Sparkline, Line/Bar/Area/Pie — themed from the design tokens
src/types/contract.ts  the one seam. Mirrors the Pydantic models; one writer only
```

`src/App.tsx` is still the template's health screen. That is the file to replace first.

## The formula

`backend/affordability.py`, `compute()` — deterministic, and the only source of every
number the UI shows:

```
disposable  = income - expenses           capacity = disposable * commit_share (default 30%)
buffer      = expenses * emergency_months spendable = max(0, savings - buffer)
months      = max(0, price - spendable) / capacity
work_hours  = price / (income / 173.33)
verdict     = price/disposable  ≤0.10 easy · ≤0.35 affordable · ≤1.0 stretch · ≤3.0 plan_it · else out_of_reach
```

The model is handed those figures and asked for a headline, reasoning, one action, a
tradeoff and alternatives. It never computes; a model that does arithmetic will be
confidently wrong about a month count, which is the one thing a money tool cannot be.

## Before this becomes a submission

Module READMEs and instruction headers are still in the tree — they are the wiring
reference while building. `bash ../kit/scrub.sh .` strips them, plus anything else that
names where the code came from. Delete any `src/lib/` module that ends up unused.
