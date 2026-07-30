// searchClient.ts — the two calls (/api/search, /api/search/ground) validated into the module's types.
// COPY: with the rest of kit/search into src/lib/search/. Used by useGroundedAnswer.ts; usable on its own.
// CHANGE: nothing. The URL and the timeouts live in searchHttp.ts and are re-exported below.

import { searchError } from './searchTypes';
import { DEFAULT_GROUND_TIMEOUT_MS, DEFAULT_SEARCH_TIMEOUT_MS, num, postSearch, record, shapeError, text } from './searchHttp';
import type { Claim, GroundOutcome, SearchOutcome, SearchResult } from './searchTypes';
import type { SearchFetchOptions } from './searchHttp';

export { DEFAULT_BASE_URL, DEFAULT_SEARCH_TIMEOUT_MS, DEFAULT_GROUND_TIMEOUT_MS } from './searchHttp';
export type { SearchFetchOptions } from './searchHttp';

/** ground.py's MAX_SOURCES. More results than this cannot be grounded, so we refuse early. */
export const MAX_GROUND_SOURCES = 10;

export interface SearchParams {
  /** 1..MAX_GROUND_SOURCES. Anything else fails as `invalid_params` before a request is sent. */
  maxResults?: number;
  searchDepth?: 'basic' | 'advanced';
  topic?: 'general' | 'news' | 'finance';
  includeDomains?: string[];
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

export async function requestSearch(
  query: string,
  params: SearchParams = {},
  options: SearchFetchOptions = {},
): Promise<SearchOutcome> {
  const maxResults = params.maxResults ?? 5;
  // Refused here instead of as a 422 a round trip later: /api/search/ground takes at most
  // MAX_GROUND_SOURCES, so retrieving more would strand results that can never be cited.
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_GROUND_SOURCES) {
    throw searchError(
      'invalid_params',
      `maxResults must be a whole number from 1 to ${MAX_GROUND_SOURCES} (got ${maxResults}). The ceiling is MAX_SOURCES in ground.py — raise both together if you truly need more.`,
    );
  }
  const body = await postSearch(
    '',
    {
      query,
      max_results: maxResults,
      search_depth: params.searchDepth ?? 'basic',
      topic: params.topic ?? 'general',
      include_domains: params.includeDomains ?? [],
      time_range: params.timeRange ?? null,
    },
    options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    options,
  );
  const root = record(body);
  if (!root || !Array.isArray(root.results)) throw shapeError('/api/search', 'no `results` array', body);
  const results: SearchResult[] = root.results.map((entry) => {
    const item = record(entry);
    const url = item && text(item.url);
    const score = item && num(item.score);
    if (!url || score === null) {
      throw shapeError('/api/search', 'a result without a `url` or a numeric `score`', entry);
    }
    return {
      url,
      title: item && typeof item.title === 'string' ? item.title : '',
      snippet: item && typeof item.snippet === 'string' ? item.snippet : '',
      score,
    };
  });
  const elapsed = num(root.elapsed_ms);
  if (elapsed === null) throw shapeError('/api/search', 'no `elapsed_ms`', body);
  return { query: text(root.query) ?? query, results, elapsedMs: elapsed };
}

export async function requestGround(
  question: string,
  sources: SearchResult[],
  args: { system?: string } = {},
  options: SearchFetchOptions = {},
): Promise<GroundOutcome> {
  const body = await postSearch(
    '/ground',
    {
      question,
      sources: sources.map((s) => ({ title: s.title, url: s.url, snippet: s.snippet })),
      system: args.system ?? null,
    },
    options.timeoutMs ?? DEFAULT_GROUND_TIMEOUT_MS,
    options,
  );
  const root = record(body);
  if (!root || !Array.isArray(root.claims)) throw shapeError('/api/search/ground', 'no `claims` array', body);
  const claims: Claim[] = root.claims.map((entry) => {
    const item = record(entry);
    const claimText = item && text(item.text);
    const indexes = item && Array.isArray(item.sources) ? item.sources : null;
    if (!claimText || !indexes) {
      throw shapeError('/api/search/ground', 'a claim without `text` or `sources`', entry);
    }
    // A citation the user cannot click is a decorative citation. Reject it instead of rendering it.
    const cited = indexes.map((value) => {
      const index = num(value);
      if (index === null || !Number.isInteger(index) || index < 0 || index >= sources.length) {
        throw shapeError('/api/search/ground', `a claim citing source ${String(value)} of ${sources.length}`, entry);
      }
      return index;
    });
    if (cited.length === 0) throw shapeError('/api/search/ground', 'a claim citing nothing', entry);
    return { text: claimText, sources: cited };
  });
  const model = text(root.model);
  const elapsed = num(root.elapsed_ms);
  if (!model || elapsed === null) throw shapeError('/api/search/ground', 'no `model` / `elapsed_ms`', body);
  return { claims, gaps: typeof root.gaps === 'string' ? root.gaps : '', model, elapsedMs: elapsed };
}
