<!-- README.md — why this module exists (the Functional Completeness 9 mechanic) and how to use it in 15 lines.
     COPY: the whole ui-states/ folder into src/ui-states/; import './ui-states/states.css' once in main.tsx.
     CHANGE: nothing here — this is documentation for your team, not shipped code. -->

# ui-states — make "every state handled" a compile error, not a promise

> **Start from [`EXAMPLE.tsx`](EXAMPLE.tsx), do not guess the API.**
> It is a complete, `tsc --strict`-verified wiring of `useAsync` + `fetchJson` +
> `AsyncBoundary` + `defaultSlots` + `AsyncButton` against a real backend call.
> Copy it over `src/App.tsx` and replace the domain types.
>
> `AsyncBoundary` requires **every** slot — idle, loading, error, empty, unsupported,
> success — plus `onRetry`. Omitting one is a compile error. That is the point: it is
> the Functional Completeness 9 discipline enforced by the type system rather than by
> memory at 19:15.

> **Matching the template palette.** `states.css` defines its own `--ui-*` variables so the
> module works standalone. Inside `template/`, point them at the template's tokens once and
> the two palettes stop drifting — "brand cohesion" is scored literally, off the screenshots:
>
> ```css
> :root {
>   --ui-bg: var(--color-bg);         --ui-surface: var(--color-surface);
>   --ui-border: var(--color-border); --ui-text: var(--color-text);
> }
> ```


## Why

The only project to score **9/10 on Functional Completeness** did one thing: it had **no mocks, no fixtures, no DEMO_MODE**, endpoints that **hard-fail with HTTP 500** instead of returning fake data, an **error branch on every async path**, a **loading state on every button**, and a **graceful-degradation path when a browser capability was missing**.

Under a 90-minute clock nobody remembers to write five branches. So this module removes the choice:

- `useAsync` returns a **discriminated union** — `idle | loading | error | empty | unsupported | success`. You cannot read `data` without narrowing to `success`.
- `AsyncBoundary` takes **all five non-success slots as required props**. Forget one → TypeScript error, not a blank screen.
- `AsyncButton` takes **`pending` as a required prop**. There is no way to render a button without its loading state.
- `fetchJson` **throws a typed `AppError`** parsed from the backend's `{code, message}` (also unwraps FastAPI's `{detail:{...}}` and flattens 422 validation lists). It never returns a placeholder object; HTTP 204/empty bodies land in `empty`, not in a fake success.
- `capability` turns a missing browser API into the `unsupported` state that names the capability and what to do — the graceful-degradation path, one option object away.
- Every request has a **30s timeout**, so a hung backend becomes a real `timeout` error instead of a spinner that never stops.

Stale responses and unmounted components are dropped via an `AbortController` + request-id guard, so a fast second click can never resurrect an old result.

## Files

| File | Contains |
| --- | --- |
| `fetchJson.ts` | `AppError`, `fetchJson`, `parseErrorResponse`, `toAppError` — no React import |
| `useAsync.ts` | `AsyncState`, `useAsync`, `match` — re-exports everything from `fetchJson.ts` |
| `AsyncBoundary.tsx` | `AsyncBoundary`, `AsyncSwitch` |
| `states.tsx` | `defaultSlots`, `Loading`, `ErrorState`, `Empty`, `Unsupported`, `Idle`, `AsyncButton`, `Spinner` |
| `states.css` | Dark-theme styling — import once in `main.tsx` |

You can import everything from `./ui-states/useAsync`; `fetchJson.ts` is split out only to keep files short and is also usable on its own.

## Usage

```tsx
import { useAsync, fetchJson } from './ui-states/useAsync';
import { AsyncBoundary } from './ui-states/AsyncBoundary';
import { defaultSlots, AsyncButton } from './ui-states/states';

type Run = { id: string; title: string };

export function Runs() {
  const { state, run, retry } = useAsync<Run[]>((signal) => fetchJson<Run[]>('/api/runs', { signal }), { immediate: true });
  return (
    <section>
      <AsyncButton pending={state.status === 'loading'} onClick={() => run()}>Refresh</AsyncButton>
      <AsyncBoundary
        state={state}
        onRetry={retry}
        {...defaultSlots({ noun: 'runs', emptyHint: 'Start an analysis to see runs here.' })}
        success={(runs) => <ul>{runs.map((r) => <li key={r.id}>{r.title}</li>)}</ul>}
      />
    </section>
  );
}
```

## With arguments and a browser capability

```tsx
const { state, run, retry } = useAsync<Transcript, [Blob]>(
  (signal, clip) => {
    const body = new FormData();          // do NOT set Content-Type yourself — see gotcha 2
    body.append('clip', clip);
    return fetchJson<Transcript>('/api/transcribe', { method: 'POST', body, signal, timeoutMs: 120_000 });
  },
  {
    capability: {
      name: 'Microphone access',
      check: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
      hint: 'Open the app on http://localhost (not a LAN IP) or over https://, then allow the mic prompt. You can still paste text below.',
    },
    isEmpty: (t) => t.segments.length === 0,
  },
);
```

`run(clip)` short-circuits to `{ status: 'unsupported' }` without calling the API when the check fails.

## Gotchas that cost real time — and the fix

1. **`network_error: Could not reach the server`** — the API is not running, the port is wrong, or CORS is blocking you. The browser gives JS no CORS detail on purpose, so check the Network tab. Fix on the FastAPI side:
   ```python
   from fastapi.middleware.cors import CORSMiddleware
   app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"],
                      allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
   ```
   Or skip CORS entirely with a Vite proxy in `vite.config.ts`, then call `/api/...` same-origin:
   ```ts
   server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } } }
   ```
2. **File uploads return 422** — you set `Content-Type: multipart/form-data` by hand, which strips the boundary the browser generates. `fetchJson` only auto-sets `Content-Type: application/json` for **string** bodies; pass `FormData` and set nothing.
3. **Auth header disappears** — pass headers as a plain object or a `Headers` instance; both work here. (`{...someHeadersInstance}` spreads to `{}` in plain JS, which is how tokens silently vanish. `fetchJson` merges via `new Headers()` so this cannot happen.)
4. **`insecure_context` / capability check fails on your phone** — `getUserMedia`, clipboard, notifications and service workers need a secure context. `localhost` and `127.0.0.1` count; `192.168.x.x` does **not**. Fix: test on the laptop, or run `vite --host` behind an https tunnel.
5. **`permission_denied`** — the API exists but the user (or a previous "Block") denied it. The capability check cannot see this; it arrives as a rejection and is mapped to a `permission_denied` error with retry. Tell the user to click the blocked icon in the address bar. Reset it in Chrome via the icon left of the URL.
6. **`bad_response` / "HTML page instead of JSON"** — your dev-server proxy 404ed and returned `index.html`. Check the route prefix matches the proxy prefix.
7. **`client_type_error`** — a bug in your own code (a null dereference), *not* a network problem. This module deliberately refuses to label client bugs as network failures, because that misdiagnosis is a 20-minute detour.
8. **Two requests fire on mount in dev** — React 19 StrictMode double-invokes effects. The first is aborted and discarded by the request-id guard; it is not a bug and does not happen in the build.
9. **`immediate: true` only works when the runner needs no arguments.** With `useAsync<T, [Blob]>` the immediate call would pass `undefined`. Call `run(arg)` from an event instead.

## Rules for the team

1. Never `useState` + `try/catch` by hand for a request — always `useAsync`.
2. Never render a `success` view outside an `AsyncBoundary`.
3. Never write `catch { return [] }` or any placeholder value. Let it throw; `error` is a real, useful state.
4. Every button that triggers a request is an `AsyncButton` with `pending` bound to a real status.
5. Anything touching a browser API (mic, camera, clipboard, WebSocket, WebGPU, notifications) gets a `capability` with a hint that tells the user what still works without it.
6. Always forward the `signal` into `fetch` so superseded requests are actually cancelled.

## API surface

| Export | From | What it does |
| --- | --- | --- |
| `useAsync(fn, options)` | `useAsync.ts` | Returns `{ state, run, retry, reset }`; aborts stale/unmounted calls |
| `AsyncState<T>`, `AppError` | `useAsync.ts` | The union and the typed backend error |
| `match(state, handlers)` | `useAsync.ts` | Exhaustive switch as an expression (non-JSX use) |
| `fetchJson<T>(url, init)` | `fetchJson.ts` | Throws typed errors, never fake data; `timeoutMs` defaults to 30s |
| `parseErrorResponse`, `toAppError`, `isAppError` | `fetchJson.ts` | Response/throwable → `AppError` |
| `AsyncBoundary`, `AsyncSwitch` | `AsyncBoundary.tsx` | Render the union with all slots required |
| `defaultSlots`, `Loading`, `ErrorState`, `Empty`, `Unsupported`, `Idle`, `AsyncButton`, `Spinner` | `states.tsx` | Dark-theme default views |
