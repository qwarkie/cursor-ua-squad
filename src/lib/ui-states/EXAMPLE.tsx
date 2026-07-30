/**
 * Working reference wiring for ui-states + a backend call.
 * Copy this over src/App.tsx at minute 0, then replace the domain bits.
 * Verified to compile under `tsc --strict`. Do not guess the API — start here.
 */
import { useAsync, fetchJson } from './useAsync';
import { AsyncBoundary } from './AsyncBoundary';
import { defaultSlots, AsyncButton } from './states';
import './states.css';

// ── 1. The shape your backend returns. Change this. ──────────────────────────
type Analysis = {
  summary: string;
  topics: string[];
};

export default function App() {
  // ── 2. The call. `signal` is wired to abort on unmount / re-run. ───────────
  const analysis = useAsync<Analysis, [string]>(
    (signal, text) =>
      fetchJson<Analysis>('http://127.0.0.1:8000/analyze', {
        signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    {
      // Treat a result with nothing in it as `empty`, not as `success`.
      isEmpty: (data) => data.topics.length === 0,
    },
  );

  return (
    <main className="app">
      <h1>Analyzer</h1>

      {/* `pending` disables the button and swaps the label — no double submits. */}
      <AsyncButton
        pending={analysis.state.status === 'loading'}
        onClick={() => void analysis.run('the text to analyze')}
      >
        Analyze
      </AsyncButton>

      {/* Every branch is required. Omit one and this will not compile. */}
      <AsyncBoundary
        state={analysis.state}
        onRetry={analysis.retry}
        {...defaultSlots({ noun: 'topics' })}
        success={(data) => (
          <section>
            <p>{data.summary}</p>
            <ul>
              {data.topics.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        )}
      />
    </main>
  );
}
