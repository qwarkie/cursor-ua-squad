// The answer: can this month carry this thing, and if not, what the plan is.
//
// The four figures come from Python. The words come from the model, which was handed those
// figures and told not to recompute them. The footnote says so, because a money verdict that
// cannot be traced back to the user's own inputs is not worth reading.

import { CheckCircle, Clock, CurrencyDollar, Hourglass01 } from '@untitledui/icons';
import type { AssessResponse, Verdict } from '@/types/contract';

/** Text, not colour alone: the five bands must be distinguishable without seeing hue. */
const BANDS: Record<Verdict, { label: string; tone: string; blurb: string }> = {
  easy: {
    label: 'Easy',
    tone: 'bg-success-secondary text-success-primary',
    blurb: 'inside the noise of one month',
  },
  affordable: {
    label: 'Affordable',
    tone: 'bg-success-secondary text-success-primary',
    blurb: 'fits without rearranging anything',
  },
  stretch: {
    label: 'A stretch',
    tone: 'bg-warning-secondary text-warning-primary',
    blurb: 'most of one month of spare money',
  },
  plan_it: {
    label: 'Plan it',
    tone: 'bg-warning-secondary text-warning-primary',
    blurb: 'reachable, but it needs saving up for',
  },
  out_of_reach: {
    label: 'Out of reach',
    tone: 'bg-error-secondary text-error-primary',
    blurb: 'not at the current commitment rate',
  },
};

function money(currency: string, value: number) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
}

export function VerdictCard({ data }: { data: AssessResponse }) {
  const band = BANDS[data.math.verdict];
  const { math, advice } = data;

  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-secondary bg-primary p-4 shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-md font-semibold">{data.item_name}</h3>
          <p className="mt-0.5 text-sm text-tertiary">
            {money(data.currency, data.price)} · {data.category}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${band.tone}`}>{band.label}</span>
      </header>

      <p className="text-md leading-relaxed">{advice.headline}</p>
      <p className="text-sm leading-relaxed text-tertiary">{advice.reasoning}</p>

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-secondary p-3 sm:grid-cols-4">
        <Figure
          icon={<CurrencyDollar className="size-3.5" />}
          label="Of spare money"
          value={`${Math.round(math.share_of_disposable * 100)}%`}
        />
        <Figure
          icon={<Clock className="size-3.5" />}
          label="Hours of work"
          value={math.work_hours.toFixed(1)}
        />
        <Figure
          icon={<Hourglass01 className="size-3.5" />}
          label="Months of saving"
          value={math.months_to_save === 0 ? 'none' : math.months_to_save.toFixed(1)}
        />
        <Figure
          icon={<CheckCircle className="size-3.5" />}
          label="Payable today"
          value={math.payable_from_savings ? 'yes' : 'no'}
        />
      </dl>

      {/* A neutral surface with a brand border, not a brand fill. In dark mode the brand
          surfaces are saturated, and neutral text tokens on top of them drop below AA:
          "to cover 329" and the tradeoff line were dark violet on violet. The border and
          the heading carry the accent instead, so contrast holds in both themes. */}
      <section className="rounded-xl border border-brand bg-secondary p-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-brand-secondary">The plan</h4>

        {/* The numbers first, and they are computed: the shortfall, the weekly amount that
            covers it, and how many weeks that takes. The model's sentence follows and is
            told to quote exactly these, so the two can never disagree. */}
        {math.shortfall > 0 && (
          <p className="mt-1.5 text-md font-semibold tabular-nums">
            {money(data.currency, math.weekly_capacity)} a week for {math.weeks_to_save}{' '}
            {math.weeks_to_save === 1 ? 'week' : 'weeks'}
            <span className="font-normal text-tertiary">
              {' '}
              to cover {money(data.currency, math.shortfall)}
            </span>
          </p>
        )}

        <p className="mt-1.5 text-sm leading-relaxed">{advice.action}</p>
        <p className="mt-2 text-sm text-tertiary">{advice.tradeoff}</p>
      </section>

      {math.breaks_emergency_fund && (
        <p className="rounded-xl border border-tertiary bg-secondary px-3 py-2 text-sm text-warning-primary">
          Paying cash today would eat into the buffer you said you keep.
        </p>
      )}

      {advice.alternatives.length > 0 && (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-quaternary">Cheaper ways</h4>
          <ul className="mt-1.5 flex flex-col gap-1">
            {advice.alternatives.map((item) => (
              <li key={item} className="text-sm text-tertiary">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-quaternary">
        Every figure computed from your own numbers at {money(data.currency, math.hourly_rate)} an hour.{' '}
        {data.model} wrote only the words.
      </p>
    </article>
  );
}

function Figure({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-tertiary">
        <span className="text-fg-quaternary">{icon}</span>
        {label}
      </dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
