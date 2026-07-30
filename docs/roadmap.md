# "Can I Afford This?" — 2-Hour MVP Plan

The goal is a working demo, not a product. Cut everything not on the critical path: no auth, no database, no accounts. One screen, one API call, localStorage for state.

## Scope (what the demo does)

1. User types their **daily earnings** once (saved in localStorage).
2. User **uploads/snaps a photo** of an object.
3. One backend call to a **vision LLM** that returns item name, estimated price, and a short affordability plan in a single JSON response.
4. Show a result card: item, price, verdict, days-to-afford, one trade-off line.

## Stack (minimal)

- **Frontend:** Vite + React + TypeScript, plain fetch, one component
- **Backend:** Python FastAPI, one `/analyze` endpoint that forwards the image to a vision LLM (Claude/GPT-4o vision)
- **State:** localStorage (earnings). No DB.
- **Key trick:** let the LLM do recognition + price estimate + plan in ONE prompt returning JSON. Don't build separate services.

---

## Timeboxed Schedule (120 min)

**0:00–0:15 — Setup**
- `npm create vite@latest -- --template react-ts`
- `pip install fastapi uvicorn python-multipart` + LLM SDK
- Get the LLM API key into an `.env`

**0:15–0:45 — Backend `/analyze`**
- POST accepts image + daily earnings
- Prompt the vision LLM, force JSON output:
  ```json
  { "item": "...", "price_usd": 0, "days_to_afford": 0, "verdict": "yes|save|no", "tradeoff": "..." }
  ```
- Return that JSON straight to the frontend

**0:45–1:15 — Frontend capture + call**
- Earnings input (persist to localStorage)
- File input with `capture="environment"` for phone camera
- Preview thumbnail → POST to `/analyze` → loading state

**1:15–1:45 — Result card**
- Show item, price, verdict badge, days-to-afford, trade-off line
- Simple math client-side if you want: `days = ceil(price / dailyEarnings)`

**1:45–2:00 — Polish & demo**
- Handle errors (bad photo, no price) with a friendly message
- Quick styling pass, test on your phone, done

---

## The One Prompt (backend core)

> "You see an image of a product. Identify the item and estimate its typical retail price in USD. The user earns ${daily} per day. Return ONLY JSON: item, price_usd, days_to_afford (price/daily rounded up), verdict (yes if under one day's pay, save if a few days, no if very expensive), and a one-line tradeoff phrased like 'this = 1.5 slow days'."

## Cut for now (do later)

Auth, database, earnings history, forecasting, goal tracking, price-API accuracy, offline support, gamification. All Phase 2+.

## If You Run Short

Skip the backend entirely — call the vision LLM directly from the frontend with a temporary key (fine for a local demo, never ship it). That saves ~30 min.
