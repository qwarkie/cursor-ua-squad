// Two columns on a desktop, one on a phone: the assistant on the left, what it worked out on
// the right. State lives here; the panels are presentational and take it as props.
//
// The transcript and the last breakdown are persisted, so a reload or a phone locking itself
// mid-conversation does not throw the answers away.

import { Wallet01 } from '@untitledui/icons';
import { useCallback, useState } from 'react';
import { BreakdownEmpty, FiguresRow, SplitCard } from '@/components/app/BreakdownPanel';
import { ChatPanel } from '@/components/app/ChatPanel';
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
    },
    [breakdown, run, transcript, turns],
  );

  const reset = useCallback(() => {
    transcript.remove();
    breakdown.remove();
    setDraft('');
  }, [breakdown, transcript]);

  return (
    <main className="p-safe min-h-dvh bg-secondary text-primary">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:py-12">
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

        {/* The figures get the full width: three of them wrap their own labels inside a
            sidebar, and they are the thing the user came to read. */}
        {current && <FiguresRow data={current} />}

        <div className="grid min-h-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
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

          <aside aria-label="Breakdown" className="lg:sticky lg:top-12">
            {current ? <SplitCard data={current} /> : <BreakdownEmpty />}
          </aside>
        </div>
      </div>
    </main>
  );
}
