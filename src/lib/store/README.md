<!-- README.md — how to drop the store module into a fresh repo. -->
<!-- COPY: nothing from this file ships; it is instructions only. -->
<!-- CHANGE: nothing. Read it, take the files you need. -->

# store — state that survives a refresh

Typed `localStorage` / `sessionStorage` with Zod validation on read, plus a SQLite-backed
`/api/items` when the state has to outlive the browser. A demo gets reloaded; this is what
makes the reload boring.

| File | Where it goes | Needs |
| --- | --- | --- |
| `storageCore.ts` | `src/lib/store/` | — (probe, typed errors, JSON codec, same-tab bus) |
| `storeState.ts` | `src/lib/store/` | `storageCore.ts` (the `StoreState` union + `matchStore`) |
| `useWebStorage.ts` | `src/lib/store/` | react, the two files above |
| `useLocal.ts` | `src/lib/store/` | the three files above |
| `useSession.ts` | `src/lib/store/` | the three files above |
| `StorageNotice.tsx` | `src/lib/store/` | `storeState.ts` (Tailwind + Untitled UI tokens) |
| `itemsClient.ts` | `src/lib/store/` | `storageCore.ts` (URLs, HTTP error mapping, validation) |
| `useItems.ts` | `src/lib/store/` | react, `itemsClient.ts`, the backend router mounted |
| `db.py` | `backend/` | — (`sqlite3` is in the standard library) |
| `store_router.py` | `backend/` | `db.py`, fastapi, pydantic |

## Copy it in

```bash
BASE=~/Desktop/cursor-hackathon-base
cp -r $BASE/kit/store src/lib/store && rm src/lib/store/{README.md,db.py,store_router.py}
npm i zod

# only if the state must outlive the browser:
cp $BASE/kit/store/{db,store_router}.py backend/
echo "backend/data/" >> .gitignore
```

`zod` is the only dependency, and only the browser half needs it. There is nothing to
`pip install` — `sqlite3` ships with Python.

## Usage — 15 lines that compile

```tsx
import { z } from 'zod';
import { useLocal } from '@/lib/store/useLocal';
import { StorageNotice } from '@/lib/store/StorageNotice';

const Notes = z.array(z.object({ id: z.string(), text: z.string() }));

export function Notepad() {
  const notes = useLocal('notes', Notes, []);
  if (notes.state.status === 'loading') return null;   // one guard, then `value` is typed
  const { value } = notes.state;                       // idle | ready | error | unsupported
  return (
    <>
      <StorageNotice state={notes.state} onDiscard={notes.remove} onRetry={notes.reload} />
      <button onClick={() => notes.set((n) => [...n, { id: crypto.randomUUID(), text: '' }])}>Add ({value.length})</button>
    </>
  );
}
```

`useSession` is the same call with a tab-scoped lifetime. `matchStore(state, {...})` is the
exhaustive alternative to the guard — omit a branch and the build fails.

### What each status means

| status | when | `value` |
| --- | --- | --- |
| `loading` | first render only — the read happens in a layout effect, which commits **before paint**, so this never flashes | — |
| `idle` | storage works, this key was never written | your fallback |
| `ready` | read back and validated | the stored value |
| `error` | stored JSON is corrupt, or the shape no longer matches the schema | your fallback |
| `unsupported` | Private Browsing, blocked cookies, no `window` | your fallback, kept in memory |

`error` and `unsupported` still hand you a usable value so the screen renders — but the
status says plainly that nothing is being persisted, and `StorageNotice` puts that on screen.
Nothing is ever silently swallowed: a stale shape names the failing field
(`0.id: Invalid input: expected string, received number`), and the fix is one click on
**Discard stored value** (`remove()`).

In `unsupported`, `set()` still updates an in-page memory area and every other hook on the
same key sees it — otherwise "the app keeps working, it just does not persist" would be a
half-truth and two components on one key would silently disagree. It is never read when
storage works, so it hides no failure.

## Server side — persistence without designing a schema

```python
from store_router import router as store_router   # backend/main.py
app.include_router(store_router)                  # this line is the entire wiring
```

One table, one JSON payload column, `collection` as the namespace. `init_db()` runs on import
and creates the table if it is absent — no migrations, no service to start, one file at
`backend/data/store.db` (override with `STORE_DB_PATH`).

```
POST   /api/items            {collection, payload, id?}  → Item   (id present = overwrite, created_at kept)
GET    /api/items?collection=notes&limit=100&offset=0    → {collection, count, items}
GET    /api/items/{id}                                   → Item | 404
DELETE /api/items/{id}                                   → {deleted: 1} | 404
DELETE /api/items?collection=notes                       → {deleted: n}
```

`collection` is required on the list and bulk-delete routes on purpose: there is no request
that dumps or wipes the whole table by accident. Every failure comes back as
`{"detail": {"error", "message", "hint"}}` with a real status — 404 for a missing row, 413
over 256 KB, 422 for a bad collection name, 500 with the SQLite message for anything else.

From the browser:

```tsx
const notes = useItems('notes', z.object({ text: z.string() }));
// idle | loading {items} | ready {items} | error {error, items} | unsupported
await notes.save({ text: 'hello' });     // → {ok: true, data: Item} | {ok: false, error}
await notes.remove(id); await notes.clear(); await notes.reload();
```

Mutations reload from the server instead of patching a local copy, so what you render is what
is actually on disk. A row whose payload fails the schema fails the **whole list**, loudly —
dropping it quietly would hide a real bug behind a shorter list.

`loading` and `error` carry `items`: the **last list the server actually confirmed**, never an
invention. That is why a refresh does not blank the screen mid-demo and a failed save does not
delete the list in front of a judge — the status still says the view is stale. `matchItems(state, {...})`
is the exhaustive matcher; `state.error` is field-compatible with `ui-states`' `AppError`, so
`<ErrorState error={state.error} onRetry={notes.reload} />` renders it unchanged.

## Traps that eat twenty minutes

- **Safari Private Browsing does not throw where you expect.** `window.localStorage` is still
  there and `getItem` works; the first `setItem` throws `QuotaExceededError` because the quota
  is zero. That is why the hook does a real one-byte test write on mount. With *Block all
  cookies*, touching the property itself throws `SecurityError`. Both land on `unsupported`
  with the fix in `hint` — **the app keeps working in memory, it just does not persist.**
  The same probe fails when the 5 MB origin quota is already full, and the `hint` names both
  causes; the fix for the second is devtools → Application → Storage → *Clear site data*.
- **Two demos share one origin.** Everything on `localhost:5173` reads the same
  `localStorage`, so yesterday's project leaves keys behind that today's schema rejects. Pass
  `{ prefix: 'myapp:' }`, or clear site data once before the demo.
- **Edit a schema, break every stored value.** That is the point — it surfaces as
  `status: 'error'` naming the field, not as `undefined` crashing a child component mid-demo.
  `remove()` is the fix; wire it to the Discard button.
- **The `storage` event never fires in the tab that wrote.** Other tabs stay in sync through
  it; components inside one tab stay in sync through an in-page bus. A *third party* writing
  in this tab (devtools, another library) is invisible until you call `reload()`.
- **The quota is about 5 MB per origin.** A base64 photo will blow it and you get
  `write_failed`. Large blobs belong in `/api/items` or in a model call, not in `localStorage`.
- **`crypto.randomUUID()` needs a secure context.** It is `undefined` on `http://<lan-ip>`.
  The template serves LAN HTTPS, so scan the QR instead of typing the URL without the `s`.
- **iOS Safari evicts `localStorage` after ~7 days of no visits** (ITP). Irrelevant on the
  night, fatal for a judge opening the link next week — anything that must last belongs on the
  server.
- **`sessionStorage` is per tab.** Duplicating a tab copies the values once and the two copies
  then drift apart. Use it for a draft, not for the thing you demo from two devices.
- **`backend/data/` is not in the template `.gitignore`.** Add it, or you commit the database
  plus its `-wal` and `-shm` files.
- **One SQLite connection cannot cross threads.** FastAPI runs sync endpoints in a threadpool,
  so `db.py` opens a connection per call and enables WAL. Do not "optimise" that into a global
  connection unless you enjoy `SQLite objects created in a thread can only be used in that
  same thread`.
- **`backend/data/store.db` outlives your rehearsal.** Yesterday's rows are still in the
  collection when you demo. Clear it before you present: `curl -X DELETE
  'http://127.0.0.1:8000/api/items?collection=notes'`, or delete `backend/data/` and restart —
  `init_db()` rebuilds the table on the next import.

## Composes with

`ui-states` — `StoreError` carries `{code, message, status, detail}`, so
`<ErrorState error={...} />` renders both `useLocal`'s `state.error` and `useItems`'
`state.error` unchanged, and `useAsync` handles anything you load *before* persisting it.
