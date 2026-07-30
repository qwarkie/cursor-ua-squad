// Citations.tsx — the answer as claims with numbered inline markers, plus the source list they point into.
// COPY: with the rest of kit/search into src/lib/search/. Render it when the hook state is 'ready'.
// CHANGE: the token classes below to match your palette. The numbering is index + 1 and must stay that way.

import { useCallback, useId, useRef, useState } from 'react';
import { hostname, sourcesFor } from './searchTypes';
import type { Claim, GroundedAnswer, SearchResult } from './searchTypes';

export interface CitationsProps {
  answer: GroundedAnswer;
  /** Fires when a marker or a source row is activated — use it to open a preview pane. */
  onSelectSource?: (result: SearchResult, index: number) => void;
  className?: string;
}

export interface SourceListProps {
  sources: SearchResult[];
  activeIndex?: number | null;
  onSelectSource?: (result: SearchResult, index: number) => void;
  /** Called back with the <li> element per index so a marker can scroll it into view. */
  registerRef?: (index: number, element: HTMLLIElement | null) => void;
}

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The superscript `[n]` after a claim. Numbering is 1-based for humans, 0-based on the wire. */
function Markers({
  claim,
  sources,
  activeIndex,
  onActivate,
}: {
  claim: Claim;
  sources: SearchResult[];
  activeIndex: number | null;
  onActivate: (index: number) => void;
}) {
  return (
    <>
      {sourcesFor(claim, sources).map(({ index, result }) => (
        <button
          key={index}
          type="button"
          onClick={() => onActivate(index)}
          aria-label={`Source ${index + 1}: ${result.title || hostname(result.url)}`}
          className={`ml-1 inline-flex h-4.5 min-w-4.5 cursor-pointer items-center justify-center rounded-md px-1 align-super text-xs font-semibold ${
            activeIndex === index ? 'bg-brand-solid text-primary_on-brand' : 'bg-secondary text-tertiary'
          }`}
        >
          {index + 1}
        </button>
      ))}
    </>
  );
}

export function SourceList({ sources, activeIndex = null, onSelectSource, registerRef }: SourceListProps) {
  return (
    <ol className="flex flex-col gap-2">
      {sources.map((result, index) => (
        <li
          key={`${result.url}-${index}`}
          ref={registerRef ? (element) => registerRef(index, element) : undefined}
          className={`flex gap-3 rounded-xl border p-3 ${
            activeIndex === index ? 'border-brand bg-brand-primary' : 'border-secondary bg-primary'
          }`}
        >
          <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md bg-secondary px-1 text-xs font-semibold text-tertiary">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => onSelectSource?.(result, index)}
              className="truncate text-sm font-medium text-brand-secondary hover:text-brand-secondary_hover"
            >
              {result.title || hostname(result.url)}
            </a>
            <span className="truncate text-xs text-tertiary">{hostname(result.url)}</span>
            {result.snippet ? <p className="line-clamp-2 text-xs text-tertiary">{result.snippet}</p> : null}
          </div>
          <span className="text-xs tabular-nums text-tertiary">{result.score.toFixed(2)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Citations({ answer, onSelectSource, className }: CitationsProps) {
  const uid = useId();
  // The highlight is stored WITH the answer it belongs to. Ask a second question and the
  // new answer has a different identity, so index 3 stops highlighting an unrelated source.
  const [selection, setSelection] = useState<{ answer: GroundedAnswer; index: number } | null>(null);
  const activeIndex = selection && selection.answer === answer ? selection.index : null;
  const rows = useRef(new Map<number, HTMLLIElement>());

  const registerRef = useCallback((index: number, element: HTMLLIElement | null) => {
    if (element) rows.current.set(index, element);
    else rows.current.delete(index); // unmount: drop the node so the map cannot pin detached DOM
  }, []);

  const activate = useCallback(
    (index: number) => {
      setSelection({ answer, index });
      rows.current.get(index)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'nearest',
      });
      onSelectSource?.(answer.sources[index], index);
    },
    [answer, onSelectSource],
  );

  return (
    <div className={`flex flex-col gap-5 ${className ?? ''}`}>
      <div className="flex flex-col gap-3">
        {answer.claims.map((claim, index) => (
          <p key={`${uid}-claim-${index}`} className="text-md text-primary">
            {claim.text}
            <Markers claim={claim} sources={answer.sources} activeIndex={activeIndex} onActivate={activate} />
          </p>
        ))}
      </div>

      {answer.gaps ? (
        <p className="rounded-xl border border-secondary bg-secondary p-3 text-sm text-tertiary">
          <span className="font-semibold text-secondary">Not covered by these sources: </span>
          {answer.gaps}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-secondary">
          Sources ({answer.sources.length}) · {answer.model} · {answer.searchMs + answer.elapsedMs} ms
        </h3>
        <SourceList
          sources={answer.sources}
          activeIndex={activeIndex}
          onSelectSource={onSelectSource}
          registerRef={registerRef}
        />
      </div>
    </div>
  );
}

export default Citations;
