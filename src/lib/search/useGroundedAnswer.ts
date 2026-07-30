// useGroundedAnswer.ts — one hook over both routes: ask a question, get claims that each cite a source.
// COPY: with the rest of kit/search into src/lib/search/. Needs react only; the backend is search_router.py.
// CHANGE: nothing to start. Pass maxResults / searchDepth / topic / baseUrl through options.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestGround, requestSearch } from './searchClient';
import { toSearchError } from './searchTypes';
import type { GroundedState, SearchResult } from './searchTypes';
import type { SearchParams } from './searchClient';

export interface UseGroundedAnswerOptions extends SearchParams {
  baseUrl?: string;
  /** Overrides BOTH phase ceilings. Unset is right unless one of them is genuinely timing out. */
  timeoutMs?: number;
  /** Replaces GROUND_SYSTEM in ground.py entirely. Leave it alone unless the domain demands a voice. */
  system?: string;
}

export interface UseGroundedAnswer {
  /** False only on a runtime with no `fetch` or no `AbortController` — an old in-app WebView. */
  supported: boolean;
  state: GroundedState;
  /** Search, then ground. Calling it again abandons the run in flight. */
  ask: (question: string) => Promise<void>;
  /** Re-run the last question — wire this to the error retry button. */
  retry: () => Promise<void>;
  reset: () => void;
}

const IDLE = { status: 'idle' } as const;

type Support = { supported: boolean; capability: string; reason: string; hint: string };

function detectSupport(): Support {
  const hasFetch = typeof fetch === 'function';
  const hasAbort = typeof AbortController === 'function';
  if (hasFetch && hasAbort) {
    return { supported: true, capability: 'fetch', reason: '', hint: '' };
  }
  return {
    supported: false,
    capability: hasFetch ? 'AbortController' : 'fetch',
    reason: `This runtime has no ${hasFetch ? 'AbortController' : 'window.fetch'}, so the backend cannot be called.`,
    hint: 'Open the demo in Safari or Chrome rather than an in-app browser (Instagram, LinkedIn, Slack all embed old WebViews).',
  };
}

export function useGroundedAnswer(options: UseGroundedAnswerOptions = {}): UseGroundedAnswer {
  const support = useMemo(detectSupport, []);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [state, setState] = useState<GroundedState>(() =>
    support.supported
      ? IDLE
      : { status: 'unsupported', capability: support.capability, reason: support.reason, hint: support.hint },
  );

  const mounted = useRef(true);
  const runId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastQuestion = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const ask = useCallback(
    async (question: string): Promise<void> => {
      if (!support.supported) return; // state is already `unsupported`; nothing to retry into
      const trimmed = question.trim();
      lastQuestion.current = trimmed;
      if (!trimmed) {
        setState({
          status: 'error',
          error: {
            code: 'empty_question',
            message: 'Nothing was asked. Pass a non-empty question to ask() — the input is probably not bound to state.',
            status: null,
          },
          results: [],
        });
        return;
      }

      const id = ++runId.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { baseUrl, timeoutMs, system, ...params } = optionsRef.current;
      const fetchOptions = { baseUrl, timeoutMs, signal: controller.signal };

      let found: SearchResult[] = [];
      setState({ status: 'loading', phase: 'searching', question: trimmed, results: found });
      try {
        const search = await requestSearch(trimmed, params, fetchOptions);
        if (id !== runId.current || !mounted.current) return;
        found = search.results;
        if (found.length === 0) {
          // Grounding with nothing to cite is not possible, and an uncited answer is the
          // one thing this module exists to prevent. Say so instead of calling the model.
          setState({
            status: 'error',
            error: {
              code: 'no_results',
              message: `Tavily found nothing for "${trimmed}". Broaden the wording, drop includeDomains, or widen timeRange — there is nothing to ground an answer in.`,
              status: null,
            },
            results: found,
          });
          return;
        }

        setState({ status: 'loading', phase: 'grounding', question: trimmed, results: found });
        const grounded = await requestGround(trimmed, found, { system }, fetchOptions);
        if (id !== runId.current || !mounted.current) return;
        setState({
          status: 'ready',
          data: {
            question: trimmed,
            claims: grounded.claims,
            sources: found,
            gaps: grounded.gaps,
            model: grounded.model,
            elapsedMs: grounded.elapsedMs,
            searchMs: search.elapsedMs,
          },
        });
      } catch (thrown) {
        // A superseded or unmounted run must never overwrite newer state with its own error.
        if (id !== runId.current || !mounted.current) return;
        const error = toSearchError(thrown);
        if (error.code === 'aborted') return;
        setState({ status: 'error', error, results: found });
      }
    },
    [support],
  );

  const retry = useCallback(async () => {
    const question = lastQuestion.current;
    if (question !== null) await ask(question);
  }, [ask]);

  const reset = useCallback(() => {
    runId.current += 1;
    abortRef.current?.abort();
    lastQuestion.current = null;
    setState(
      support.supported
        ? IDLE
        : { status: 'unsupported', capability: support.capability, reason: support.reason, hint: support.hint },
    );
  }, [support]);

  return { supported: support.supported, state, ask, retry, reset };
}
