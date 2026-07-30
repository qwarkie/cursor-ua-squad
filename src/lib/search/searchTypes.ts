// searchTypes.ts — every shape a caller of this module sees: the state union, the typed error, the citation.
// COPY: with the rest of kit/search into src/lib/search/. Import from '@/lib/search/searchTypes'.
// CHANGE: nothing here. Extend Claim only together with ground.py, or the two drift apart.

/** One retrieved document. `score` is Tavily's relevance, 0..1 — render it, never threshold it silently. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

/** One sentence of the answer plus the 0-based indexes of the sources it came from. Never empty. */
export interface Claim {
  text: string;
  sources: number[];
}

export interface SearchOutcome {
  query: string;
  results: SearchResult[];
  elapsedMs: number;
}

export interface GroundOutcome {
  claims: Claim[];
  /** What the question asked that the sources do not answer. Empty string when they cover it. */
  gaps: string;
  model: string;
  elapsedMs: number;
}

/** The finished artefact: claims, the sources they point into, and what stayed unanswered. */
export interface GroundedAnswer {
  question: string;
  claims: Claim[];
  sources: SearchResult[];
  gaps: string;
  model: string;
  /** Time in the model. `searchMs` is time in Tavily; they are reported separately on purpose. */
  elapsedMs: number;
  searchMs: number;
}

/** The backend's `{code, message}` envelope. `status === null` means the request never landed. */
export interface SearchError {
  code: string;
  message: string;
  status: number | null;
  detail?: unknown;
}

/** Retrieval and grounding are two round trips, so `loading` says which one is running. */
export type SearchPhase = 'searching' | 'grounding';

/** Forget a branch and TypeScript refuses to compile. Same discipline as kit/ui-states. */
export type GroundedState =
  | { status: 'idle' }
  | { status: 'loading'; phase: SearchPhase; question: string; results: SearchResult[] }
  | { status: 'ready'; data: GroundedAnswer }
  // `results` survives a grounding failure so the UI can still show what was actually found.
  | { status: 'error'; error: SearchError; results: SearchResult[] }
  | { status: 'unsupported'; capability: string; reason: string; hint: string };

export const searchError = (
  code: string,
  message: string,
  status: number | null = null,
  detail?: unknown,
): SearchError => ({ code, message, status, detail });

export function isSearchError(value: unknown): value is SearchError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SearchError>;
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

/** Any thrown value -> the typed error. A SearchError passes through untouched. */
export function toSearchError(thrown: unknown): SearchError {
  if (isSearchError(thrown)) return thrown;
  return searchError('unexpected_error', thrown instanceof Error ? thrown.message : String(thrown));
}

/**
 * Resolve a claim's indexes to the sources themselves. Safe to index because the client
 * (`requestGround`) already rejected any out-of-range citation as a bad response.
 * Repeats are collapsed in first-seen order: a model that answers `sources: [1, 1]` means
 * one citation, and rendering it twice would also give React two children with one key.
 */
export function sourcesFor(
  claim: Claim,
  sources: SearchResult[],
): { index: number; result: SearchResult }[] {
  const seen = new Set<number>();
  const resolved: { index: number; result: SearchResult }[] = [];
  for (const index of claim.sources) {
    if (index < 0 || index >= sources.length || seen.has(index)) continue;
    seen.add(index);
    resolved.push({ index, result: sources[index] });
  }
  return resolved;
}

/** `https://www.acme.com/a/b` -> `acme.com`. A URL we cannot parse is shown verbatim, not hidden. */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Exhaustive `switch` as an expression — omit a handler and the build fails. */
export function matchGrounded<R>(
  state: GroundedState,
  handlers: {
    idle: () => R;
    loading: (phase: SearchPhase, results: SearchResult[], question: string) => R;
    ready: (answer: GroundedAnswer) => R;
    error: (error: SearchError, results: SearchResult[]) => R;
    unsupported: (reason: string, hint: string, capability: string) => R;
  },
): R {
  switch (state.status) {
    case 'idle':
      return handlers.idle();
    case 'loading':
      return handlers.loading(state.phase, state.results, state.question);
    case 'ready':
      return handlers.ready(state.data);
    case 'error':
      return handlers.error(state.error, state.results);
    case 'unsupported':
      return handlers.unsupported(state.reason, state.hint, state.capability);
    default: {
      const never: never = state;
      throw new Error(`Unhandled grounded state: ${JSON.stringify(never)}`);
    }
  }
}
