// index.ts — one import path for the whole module: `import { useGroundedAnswer, Citations } from '@/lib/search'`.
// COPY: with the rest of kit/search into src/lib/search/.
// CHANGE: nothing. Import the individual files directly if you prefer explicit paths.

export { useGroundedAnswer } from './useGroundedAnswer';
export type { UseGroundedAnswer, UseGroundedAnswerOptions } from './useGroundedAnswer';

export { Citations, SourceList } from './Citations';
export type { CitationsProps, SourceListProps } from './Citations';

export {
  requestSearch,
  requestGround,
  DEFAULT_BASE_URL,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_GROUND_TIMEOUT_MS,
  MAX_GROUND_SOURCES,
} from './searchClient';
export type { SearchFetchOptions, SearchParams } from './searchClient';

export { matchGrounded, searchError, toSearchError, isSearchError, sourcesFor, hostname } from './searchTypes';
export type {
  Claim,
  GroundOutcome,
  GroundedAnswer,
  GroundedState,
  SearchError,
  SearchOutcome,
  SearchPhase,
  SearchResult,
} from './searchTypes';
