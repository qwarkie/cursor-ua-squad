// One column at every width: the assistant on top, what it worked out underneath. A single
// column is why nothing needs aligning — the figures row and the split share the container's
// edges by construction, instead of a 3-up grid trying to line up with a fixed sidebar.
// State lives here; the panels are presentational and take it as props.
//
// The transcript and the last breakdown are persisted, so a reload or a phone locking itself
// mid-conversation does not throw the answers away.

import { Wallet01 } from '@untitledui/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BreakdownEmpty, FiguresRow, SplitCard } from '@/components/app/BreakdownPanel';
import { ChatPanel } from '@/components/app/ChatPanel';
import { ScanPanel } from '@/components/app/ScanPanel';
import { STORAGE_KEYS, StoredBudgetSchema, TranscriptSchema } from '@/lib/records';
import { StorageNotice } from '@/lib/store/StorageNotice';
import { useLocal } from '@/lib/store/useLocal';
import { fetchJson, useAsync } from '@/lib/ui-states/useAsync';
import type { BudgetResponse, BudgetTurn } from '@/types/contract';

function askBudget(signal: AbortSignal, messages: BudgetTurn[]): Promise<BudgetResponse> {
  return fetchJson<BudgetResponse>('/api/budget/breakdown', {
    method: 'POST',
    body: JSON.stringify({ messages }),
    signal,
    // The model chain gives each model 60s before falling through to the next one.
    timeoutMs: 90_000,
  });
}

export default function App() {
  const transcript = useLocal<BudgetTurn[]>(STORAGE_KEYS.transcript, TranscriptSchema, []);
  const breakdown = useLocal<BudgetResponse | null>(STORAGE_KEYS.breakdown, StoredBudgetSchema, null);
  const [draft, setDraft] = useState('');

  const { state, run, retry } = useAsync<BudgetResponse, [BudgetTurn[]]>(askBudget);

  const turns = transcript.state.status === 'loading' ? [] : transcript.state.value;
  const current = breakdown.state.status === 'loading' ? null : breakdown.state.value;

  // The answer lands below the fold, so the page has to take the user there. Counting fresh
  // answers rather than watching `current` is deliberate: `current` is also populated by the
  // restore from localStorage, and scrolling on load would drag a returning user past the
  // conversation they came back to read.
  const results = useRef<HTMLElement>(null);
  const [answers, setAnswers] = useState(0);

  useEffect(() => {
    if (answers === 0) return;
    const node = results.current;
    if (!node) return;
    // Honour the OS setting: a smooth scroll is motion, and some people get sick from it.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }, [answers]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // The turn just typed has to be in what we send, not only on screen.
      const next: BudgetTurn[] = [...turns, { role: 'user', content: trimmed }];
      transcript.set(next);
      setDraft('');

      const committed = await run(next);
      if (committed.status !== 'success') return; // the chat panel renders the failure

      transcript.set([...next, { role: 'assistant', content: committed.data.reply }]);
      breakdown.set(committed.data);
      setAnswers((n) => n + 1); // drives the scroll effect above
    },
    [breakdown, run, transcript, turns],
  );

  const reset = useCallback(() => {
    transcript.remove();
    breakdown.remove();
    setDraft('');
    // Otherwise the next answer's count is unchanged and the effect does not re-fire.
    setAnswers(0);
  }, [breakdown, transcript]);

  return (
    <main className="p-safe min-h-dvh bg-secondary text-primary">
      {/* max-w-3xl, not 6xl: one column of chat and cards reads badly at 1152px, and the
          figures stay wide enough for three across (232px each) without wrapping a label. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
        <header className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-solid text-primary_on-brand">
            <Wallet01 className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Where the salary goes</h1>
            <p className="text-sm text-tertiary">
              Talk through your month once. The split is worked out from your own figures.
            </p>
          </div>
        </header>

        <StorageNotice state={transcript.state} onDiscard={transcript.remove} onRetry={transcript.reload} />

        <ChatPanel
          turns={turns}
          transcriptState={transcript.state}
          request={state}
          draft={draft}
          onDraftChange={setDraft}
          onSend={(text) => void send(text)}
          onRetry={() => void retry()}
          onReset={reset}
        />

        {/* scroll-mt clears the gap the effect above would otherwise scroll flush against. */}
        <section ref={results} aria-label="Breakdown" className="flex scroll-mt-6 flex-col gap-3">
          {current ? (
            <>
              <FiguresRow data={current} />
              <SplitCard data={current} />
            </>
          ) : (
            <BreakdownEmpty />
          )}
        </section>

        {/* Gated on a budget, and not with a disabled button: without an income and costs
            there is no spare money to measure a price against, so the panel would have to
            invent a denominator. The chat above is the prerequisite, so it says that. */}
        {current && current.monthly_income > 0 ? (
          <ScanPanel budget={current} />
        ) : (
          <p className="rounded-2xl border border-dashed border-secondary px-5 py-6 text-sm text-tertiary">
            Photographing a thing to see whether you can afford it needs an income and at least
            one cost first. Tell the assistant above, then this turns into a camera.
          </p>
        )}
      </div>
    </main>
  );
}
