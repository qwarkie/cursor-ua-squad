// The assistant window: header, transcript, composer. One framed panel so the conversation
// reads as a place rather than as loose text on a page.
//
// Tokens only. Radius rule for the whole app: panels rounded-2xl, fields rounded-xl,
// round controls rounded-full.

import { AlertCircle, RefreshCw01, Send01 } from '@untitledui/icons';
import type { FormEvent } from 'react';
import { useEffect, useRef } from 'react';
import { MicButton } from '@/components/app/MicButton';
import type { StoreState } from '@/lib/store/useLocal';
import type { AppError, AsyncState } from '@/lib/ui-states/useAsync';
import type { BudgetResponse, BudgetTurn } from '@/types/contract';

const SUGGESTIONS = [
  'I take home 4200 a month',
  'Rent is 1500, groceries about 600',
  'Transport 180, phone and internet 120',
];

export interface ChatPanelProps {
  turns: BudgetTurn[];
  transcriptState: StoreState<BudgetTurn[]>;
  request: AsyncState<BudgetResponse>;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text: string) => void;
  onRetry: () => void;
  onReset: () => void;
}

export function ChatPanel({
  turns,
  transcriptState,
  request,
  draft,
  onDraftChange,
  onSend,
  onRetry,
  onReset,
}: ChatPanelProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const pending = request.status === 'loading';

  // Follow the conversation as it grows. Scrolling the container, not the page, is what
  // keeps the chart visible next to it on a desktop.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length, pending]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend(draft);
  };

  const useSuggestion = (text: string) => {
    onDraftChange(text);
    field.current?.focus();
  };

  return (
    <section
      aria-label="Assistant"
      className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-secondary bg-primary shadow-xs"
    >
      <header className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="truncate text-sm font-semibold">Budget assistant</h2>
          <span className="hidden rounded-full bg-secondary px-2 py-0.5 text-xs text-tertiary sm:inline">
            reads numbers, never invents them
          </span>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-tertiary transition hover:bg-primary_hover hover:text-secondary"
          >
            <RefreshCw01 className="size-3.5" />
            Clear
          </button>
        )}
      </header>

      <div ref={scroller} className="flex min-h-75 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {turns.length === 0 ? (
          <div className="flex flex-1 flex-col justify-end gap-4">
            <div>
              <p className="text-md font-medium">What does the month look like?</p>
              <p className="mt-1 max-w-md text-sm text-tertiary">
                Say what you earn after tax and what it goes on. Rough numbers are fine, and you
                can add more later.
              </p>
            </div>
            <ul className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((text) => (
                <li key={text}>
                  <button
                    type="button"
                    onClick={() => useSuggestion(text)}
                    className="rounded-full border border-secondary bg-primary px-3 py-1.5 text-xs text-secondary transition hover:border-brand hover:text-brand-secondary active:scale-[0.98]"
                  >
                    {text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          turns.map((turn, index) => (
            <div
              key={`${turn.role}-${index}`}
              className={[
                'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                turn.role === 'user'
                  ? 'self-end bg-brand-solid text-primary_on-brand'
                  : 'self-start border border-secondary bg-secondary text-primary',
              ].join(' ')}
            >
              {turn.content}
            </div>
          ))
        )}

        {pending && (
          <div
            role="status"
            className="flex max-w-[85%] items-center gap-2 self-start rounded-2xl border border-secondary bg-secondary px-3.5 py-3"
          >
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="size-1.5 animate-bounce rounded-full bg-fg-quaternary"
                style={{ animationDelay: `${dot * 120}ms` }}
              />
            ))}
            <span className="sr-only">Reading your numbers</span>
          </div>
        )}

        {request.status === 'error' && <RequestError error={request.error} onRetry={onRetry} />}

        {transcriptState.status === 'error' && (
          <p className="text-xs text-error-primary">
            The saved conversation could not be read: {transcriptState.error.message}
          </p>
        )}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-secondary px-3 py-3">
        <input
          ref={field}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Type, or tap the mic"
          aria-label="Your message"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-xl border border-secondary bg-primary px-3.5 py-2.5 text-sm text-primary transition placeholder:text-placeholder focus:border-brand focus:outline-none"
        />
        <MicButton onTranscript={(text) => onDraftChange(text)} disabled={pending} />
        {/* type="submit" is load-bearing: the form is what sends. */}
        <button
          type="submit"
          disabled={!draft.trim() || pending}
          aria-label="Send"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-solid text-primary_on-brand transition hover:bg-brand-solid_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send01 className="size-5" />
        </button>
      </form>
    </section>
  );
}

function RequestError({ error, onRetry }: { error: AppError; onRetry: () => void }) {
  return (
    <div className="self-start rounded-xl border border-error_subtle bg-error-primary px-3.5 py-3">
      <p className="flex items-start gap-2 text-sm text-error-primary">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{error.message}</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-lg border border-error_subtle px-2.5 py-1 text-xs text-error-primary transition hover:bg-error-secondary"
      >
        Try again
      </button>
    </div>
  );
}
