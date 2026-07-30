// What the month actually looks like, in two pieces the page stacks under the conversation:
// the three figures, then the split itself.
//
// Every number here was computed by the backend from the user's own inputs. Nothing on this
// panel is model output, which is the claim the footnote makes explicit.
//
// StatGroup from the chart module is deliberately not used: it lays out 2 then 4 columns, so
// three figures would leave a dead fourth cell on a laptop.

import { PieChart01 } from '@untitledui/icons';
import { PieChart, Stat } from '@/lib/dataviz';
import type { BudgetResponse } from '@/types/contract';

function formatter(currency: string) {
  // A currency code the model guessed wrong must not blank the whole panel.
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  }
}

/**
 * The headline figures. Two across on a phone rather than three stacked: at 430px a stacked
 * column pushes the split a screen and a half down, and three across squeezes each tile to
 * ~125px, where "54% of take home" wraps to three lines. The odd one out spans both cells.
 */
export function FiguresRow({ data }: { data: BudgetResponse }) {
  const money = formatter(data.currency);
  const committedShare = data.monthly_income > 0 ? Math.round((data.spent / data.monthly_income) * 100) : 0;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Stat label="Take home" value={money.format(data.monthly_income)} footnote="every month" />
      <Stat
        label="Committed"
        value={money.format(data.spent)}
        footnote={data.monthly_income > 0 ? `${committedShare}% of take home` : 'income not given yet'}
      />
      <Stat
        className="col-span-2 sm:col-span-1"
        label={data.overspent ? 'Short by' : 'Left over'}
        value={money.format(Math.abs(data.leftover))}
        footnote={
          data.overspent
            ? 'stated costs exceed stated income'
            : `${Math.round(data.leftover_share * 100)}% of take home`
        }
      />
    </div>
  );
}

/** The split itself, full column width under the figures. */
export function SplitCard({ data }: { data: BudgetResponse }) {
  const money = formatter(data.currency);
  const rows = data.slices.map((slice) => ({ name: slice.name, amount: slice.amount }));

  return (
    <div className="flex flex-col gap-3">
      <PieChart
        data={rows}
        nameKey="name"
        valueKey="amount"
        donut
        title="Where the month goes"
        caption={data.needs_more ? 'Still incomplete. Keep adding what you spend on.' : undefined}
        formatValue={(value) => money.format(value)}
        height={250}
      />

      {data.missing.length > 0 && (
        <p className="text-xs text-tertiary">Not accounted for yet: {data.missing.join(', ')}.</p>
      )}

      <p className="flex items-start gap-1.5 text-xs text-quaternary">
        <PieChart01 className="mt-0.5 size-3.5 shrink-0" />
        <span>Totals and shares computed from your figures. {data.model} only read them.</span>
      </p>
    </div>
  );
}

/** Shown before the first answer, so the column is composed rather than blank. */
export function BreakdownEmpty() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-secondary border-dashed px-5 py-8">
      <span className="grid size-9 place-items-center rounded-full bg-secondary text-fg-quaternary">
        <PieChart01 className="size-4.5" />
      </span>
      <div>
        <p className="text-sm font-medium">The split appears here</p>
        <p className="mt-1 max-w-xs text-sm text-tertiary">
          Once there is an income and at least one cost, this column shows what the month looks
          like and how much of it is already spoken for.
        </p>
      </div>
    </div>
  );
}
