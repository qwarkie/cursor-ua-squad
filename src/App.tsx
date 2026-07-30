// The landing screen. It exists to prove one thing: the browser can reach the Python
// backend through the /api proxy, from a phone, over HTTPS. Replace the body with the
// real UI - but keep a visible error state, because a failure that hides is a lost demo.
// Styling uses Untitled UI tokens (text-tertiary, bg-secondary...). See src/components/README.md.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/base/buttons/button';
import type { HealthResponse } from '@/types/contract';

type Health =
  | { phase: 'loading' }
  | { phase: 'ready'; data: HealthResponse }
  | { phase: 'failed'; message: string };

function isHealthResponse(body: unknown): body is HealthResponse {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as Partial<HealthResponse>;
  return (
    typeof candidate.status === 'string' &&
    typeof candidate.python === 'string' &&
    typeof candidate.env_file === 'boolean' &&
    Array.isArray(candidate.env_present) &&
    Array.isArray(candidate.env_missing)
  );
}

async function fetchHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', { signal });

  // 503 is the backend saying "I am up but misconfigured" - it carries a real body,
  // and that body is the most useful thing on the screen. Everything else is a failure.
  if (!response.ok && response.status !== 503) {
    // statusText is empty over HTTP/2 and on a proxy error, so do not rely on it alone.
    const reason = response.statusText || (response.status === 502 ? 'proxy could not reach the backend' : 'see the terminal');
    throw new Error(`GET /api/health responded ${response.status} - ${reason}`);
  }

  const body: unknown = await response.json();
  if (!isHealthResponse(body)) {
    throw new Error(`GET /api/health returned an unexpected shape: ${JSON.stringify(body)}`);
  }
  return body;
}

export default function App() {
  const [health, setHealth] = useState<Health>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setHealth({ phase: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal)
      .then((data) => setHealth({ phase: 'ready', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealth({
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [attempt]);

  const healthy = health.phase === 'ready' && health.data.status === 'ok';

  return (
    // p-safe carries the notch insets; the inner div carries our own spacing. Both on one
    // element does not work - the safe-area padding overwrites px-* / py-*.
    <main className="p-safe flex min-h-dvh flex-col bg-primary text-primary">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-10">
        <header className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">APP_NAME</h1>
          <p className="mt-1 text-sm text-tertiary">
            Open this page on your phone from the QR code in the terminal.
          </p>
        </header>

        <section className="w-full max-w-md rounded-xl border border-secondary bg-secondary p-5">
          <h2 className="text-xs font-medium uppercase tracking-widest text-tertiary">Backend</h2>

          {health.phase === 'loading' && (
            <p className="mt-3 text-sm text-tertiary">Calling /api/health...</p>
          )}

          {health.phase === 'ready' && (
            <div className="mt-3">
              <p className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block size-2 rounded-full ${healthy ? 'bg-success-solid' : 'bg-error-solid'}`}
                />
                <span className={healthy ? '' : 'text-error-primary'}>
                  {health.data.status} - Python {health.data.python}
                </span>
              </p>

              {health.data.env_missing.length > 0 && (
                <>
                  <p className="mt-2 font-mono text-xs text-error-primary">
                    missing env: {health.data.env_missing.join(', ')}
                  </p>
                  <p className="mt-2 text-xs text-tertiary">
                    {health.data.env_file ? (
                      <>
                        backend/.env exists but does not set these. Add them, then restart
                        the backend - .env is read once, at import.
                      </>
                    ) : (
                      <>
                        backend/.env does not exist. Run{' '}
                        <code className="font-mono">cp backend/.env.example backend/.env</code>,
                        paste the values, restart the backend.
                      </>
                    )}
                  </p>
                </>
              )}

              <pre className="mt-3 overflow-x-auto rounded-lg bg-primary p-3 font-mono text-xs text-tertiary">
                {JSON.stringify(health.data, null, 2)}
              </pre>
            </div>
          )}

          {health.phase === 'failed' && (
            <div className="mt-3">
              <p className="flex items-start gap-2 text-error-primary">
                <span className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-error-solid" />
                <span className="font-mono text-xs leading-relaxed">{health.message}</span>
              </p>
              <p className="mt-3 text-xs text-tertiary">
                Nothing is answering behind the /api proxy. Stop everything and run{' '}
                <code className="font-mono">make dev</code>, which starts the backend and
                this page together. If you started Vite on its own, run{' '}
                <code className="font-mono">make api</code> in a second terminal.
              </p>
              <div className="mt-4">
                <Button size="sm" color="secondary" onClick={retry}>
                  Retry
                </Button>
              </div>
            </div>
          )}
        </section>

        <p className="max-w-md text-center text-xs text-tertiary">
          Camera, microphone and motion sensors need this HTTPS origin. If the phone warns
          about the certificate, accept it once.
        </p>
      </div>
    </main>
  );
}
