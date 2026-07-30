<!-- README.md — how to drop the search module into a fresh repo. -->
<!-- COPY: nothing from this file ships; it is instructions only. -->
<!-- CHANGE: nothing. Read it, take the files, mount one router. -->

# search — grounded answers with citations

A question goes in; back comes an answer split into **claims, each carrying the index of the source
it came from**, plus the source list those indexes point into. The citation is enforced by the
schema, not by the prompt: a claim with an empty `sources` array fails Pydantic validation and the
request fails. That is what makes the citation trail real rather than decorative.

**This is retrieval + citation, not embeddings.** No vector database, no chunking, no index to
build or warm. Tavily returns ranked page extracts, the model answers *only* from those extracts,
and every sentence links back to a URL a judge can click. For 90 minutes that is the right trade —
and the citation trail is the part that scores, not the retrieval technique underneath it.

| File | Where it goes | Needs |
| --- | --- | --- |
| `searchTypes.ts` | `src/lib/search/` | — (state union, typed error, `sourcesFor`) |
| `searchHttp.ts` | `src/lib/search/` | `searchTypes.ts` (one POST: timeout, abort, error envelope) |
| `searchClient.ts` | `src/lib/search/` | the two above (the two calls, validated into the types) |
| `useGroundedAnswer.ts` | `src/lib/search/` | react + the two above |
| `Citations.tsx` | `src/lib/search/` | react + `searchTypes.ts` |
| `index.ts` | `src/lib/search/` | barrel — `import { useGroundedAnswer } from '@/lib/search'` |
| `ground.py` | `backend/` | `kit/backend-llm` (`provider.py`, `errors.py`) |
| `search_router.py` | `backend/` | `ground.py`, `errors.py`, `httpx` |

## Copy

```bash
BASE=~/Desktop/cursor-hackathon-base
mkdir -p src/lib/search && cp $BASE/kit/search/*.ts $BASE/kit/search/*.tsx src/lib/search/
cp $BASE/kit/search/{ground,search_router}.py backend/
cat $BASE/kit/search/requirements-search.txt >> backend/requirements.txt   # httpx
```

Then put your Tavily key in `backend/.env` — the line is already in `kit/env/vault.env`:

```
TAVILY_API_KEY=tvly-...
```

## Wire the backend — two lines in `backend/main.py`

```python
from errors import register_error_handlers   # from kit/backend-llm
from search_router import search_router

register_error_handlers(app)      # without this, every failure is a bodyless 500
app.include_router(search_router) # mounts /api/search and /api/search/ground
```

`/ground` is mounted **inside** `search_router`, so that one `include_router` line is the whole
backend wiring. Add `TAVILY_API_KEY` to `required_env` in `backend/.env` and `/api/health` will
guard it for you.

## Use

```tsx
import { Citations, matchGrounded, useGroundedAnswer } from '@/lib/search';

export function Ask({ question }: { question: string }) {
  const { state, ask, retry } = useGroundedAnswer({ maxResults: 5 });
  return matchGrounded(state, {
    idle: () => <button onClick={() => void ask(question)} className="rounded-xl bg-brand-solid px-4 py-2 text-primary_on-brand">Ask</button>,
    loading: (phase, found) => <p className="text-sm text-tertiary">{phase === 'searching' ? 'Searching the web…' : `Reading ${found.length} sources…`}</p>,
    ready: (answer) => <Citations answer={answer} />,
    error: (error) => <button onClick={() => void retry()} className="text-sm text-error-primary">{error.message}</button>,
    unsupported: (reason, hint) => <p className="text-sm text-error-primary">{reason} {hint}</p>,
  });
}
```

`ask()` is two round trips — search, then ground — so the `loading` branch tells you which one is
running and already carries `results` once retrieval lands. Render them while the model reads:
sources appearing a beat before the answer is the single most convincing moment in this demo.

`Citations` renders each claim followed by numbered `[n]` markers; clicking one highlights and
scrolls to that source. `SourceList` is exported separately if you want the sources somewhere else.
The number shown is always **index + 1** — keep it that way or the markers stop matching the list.

## Traps, and their fixes

- **`search_key_missing` (503).** `TAVILY_API_KEY` is not in `backend/.env`, or the API was not
  restarted after you added it. The router refuses to answer from the model's own memory instead —
  an ungrounded answer is exactly what this module exists to prevent.
- **`search_quota_exceeded` (402).** The free 1,000 credits/month are spent. `searchDepth: 'basic'`
  costs 1 credit per call, `'advanced'` costs 2 — stay on `basic` unless the snippets are too thin.
- **`no_results`.** Tavily matched nothing, so the hook fails instead of calling the model with an
  empty source list. Broaden the wording, drop `includeDomains`, or widen `timeRange`.
- **`invalid_params` on `maxResults`.** The ceiling is **10**, and it is one number in two places:
  `MAX_SOURCES` in `ground.py` and `MAX_GROUND_SOURCES` in `searchClient.ts`. Retrieving more than
  `/ground` accepts would strand results that can never be cited, so the client refuses before it
  sends anything. Raise both constants together, or neither.
- **`no_sources_to_ground` (400).** Only reachable if you call `ground()` from your own endpoint
  with an empty list. Search first and pass the results — answering from the model's memory is the
  one thing this module exists to prevent.
- **`citation_out_of_range` (502).** The model cited a source number that does not exist, twice in a
  row — `ground.py` already re-asked once with the violation named. Nothing is silently dropped or
  renumbered, because both would fabricate a citation. Retry, or lower `maxResults`.
- **`parse_failure` (500) mentioning `sources`.** The model tried to return a claim with no
  citation and the validator rejected it. This is the mechanism working, not a bug; it clears on a
  retry. If it repeats, your sources genuinely do not answer the question — the model should be
  putting that in `gaps` instead.
- **Every failure is a 500 with no body.** `register_error_handlers(app)` is missing from `main.py`.
- **`route_not_found`.** `app.include_router(search_router)` is missing, or the frontend is pointed
  at a different mount — pass `baseUrl` to the hook if you moved it off `/api/search`.
- **`network_error` on the phone but not the laptop.** The page must be on the LAN HTTPS origin
  from `make dev`; `localhost` in the URL bar of a phone means the phone itself.
- **`timeout`.** The two phases have separate ceilings on purpose: 30s for search (the backend caps
  its own Tavily read at 20s) and 90s for grounding, because `kit/backend-llm` gives one model call
  60s and a shared 45s ceiling would kill requests the backend was about to answer. The rare
  corrective re-ask in `ground.py` needs a second turn — pass `useGroundedAnswer({ timeoutMs })` to
  override both if you hit it. A normal run is 5–10s end to end.
- **The venue Wi-Fi blocks outbound TLS.** Surfaces as `search_unreachable` from the *backend*, not
  the browser. Tether the laptop to a phone; nothing in this module works offline and it will say so.

## Composes with

`backend-llm` is required (`provider.py` does the grounding call) and `ui-states` shares the state
vocabulary. Pair it with `llm-stream` when you want the claims to appear one at a time, or with
`input-mic` to ask the question by voice — `ask()` takes a plain string, so a transcript drops
straight in.
