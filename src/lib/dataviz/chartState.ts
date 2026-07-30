// chartState.ts — the discriminated union every chart renders from, plus the one error type.
// COPY: ships with the folder. `matchChart` makes a forgotten branch a compile error.
// CHANGE: add a code to ChartErrorCode when you add a new way for a chart to legitimately fail.

import type { ChartTheme } from './chartTheme';
import type { RechartsModule } from './rechartsLoader';

export type ChartErrorCode =
  /** The `recharts` package did not load — usually it was never installed. */
  | 'recharts_unavailable'
  /** It loaded, but does not export the pieces this module draws with. */
  | 'recharts_incomplete'
  /** The design-system variables are not on the page, so there are no colours to draw with. */
  | 'theme_unresolved'
  /** More series than the palette has distinct colours. */
  | 'palette_exhausted'
  /** The data does not contain the keys the chart was told to plot. */
  | 'invalid_data';

/** A real Error so it can be thrown, caught and logged — carrying the fix, not just the symptom. */
export class ChartError extends Error {
  readonly code: ChartErrorCode;
  readonly hint: string;
  readonly details: readonly string[];

  constructor(code: ChartErrorCode, message: string, hint: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ChartError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

/** Anything thrown anywhere in this module, normalised without losing the original message. */
export function asChartError(thrown: unknown): ChartError {
  if (thrown instanceof ChartError) return thrown;
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new ChartError(
    'recharts_unavailable',
    `The charting library failed: ${message}`,
    'Run `npm i recharts` in the frontend and restart the dev server. If it is already installed, ' +
      'reload the page — a dynamic import that failed once keeps failing for the life of the document.',
  );
}

/** Everything a chart needs to draw one frame. Only ever handed out in the `ready` branch. */
export type ChartRuntime = {
  recharts: RechartsModule;
  theme: ChartTheme;
  /** False when the user asked for reduced motion — mark transitions are then skipped entirely. */
  animate: boolean;
};

/** The only shape a caller sees. Handle every branch or it will not compile. */
export type ChartState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; runtime: ChartRuntime }
  | { status: 'error'; error: ChartError }
  | { status: 'unsupported'; capability: string; reason: string; hint: string };

/** Exhaustive switch as an expression — omit a handler and the build fails. */
export function matchChart<R>(
  state: ChartState,
  handlers: {
    idle: () => R;
    loading: () => R;
    ready: (runtime: ChartRuntime) => R;
    error: (error: ChartError) => R;
    unsupported: (capability: string, reason: string, hint: string) => R;
  },
): R {
  switch (state.status) {
    case 'idle':
      return handlers.idle();
    case 'loading':
      return handlers.loading();
    case 'ready':
      return handlers.ready(state.runtime);
    case 'error':
      return handlers.error(state.error);
    case 'unsupported':
      return handlers.unsupported(state.capability, state.reason, state.hint);
    default: {
      const never: never = state;
      throw new Error(`Unhandled chart state: ${JSON.stringify(never)}`);
    }
  }
}
