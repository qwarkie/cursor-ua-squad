// Zod schemas for anything that gets persisted. Storage is the one place where a value can
// come back in a shape the current build never wrote — a transcript saved by yesterday's
// version, a key left behind by another app on localhost. These schemas make that surface as
// a named error state instead of as `undefined` crashing a child component mid-demo.
//
// Keep them in step with src/types/contract.ts by hand; there is no generator.

import { z } from 'zod';

export const BudgetTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export const TranscriptSchema = z.array(BudgetTurnSchema);

export const BudgetSliceSchema = z.object({
  name: z.string(),
  amount: z.number(),
  share: z.number(),
});

export const BudgetResponseSchema = z.object({
  reply: z.string(),
  currency: z.string(),
  monthly_income: z.number(),
  slices: z.array(BudgetSliceSchema),
  spent: z.number(),
  leftover: z.number(),
  leftover_share: z.number(),
  overspent: z.boolean(),
  needs_more: z.boolean(),
  missing: z.array(z.string()),
  model: z.string(),
});

/** `null` is a real stored value — "asked nothing yet" — not an absent key. */
export const StoredBudgetSchema = z.union([BudgetResponseSchema, z.null()]);

export const STORAGE_KEYS = {
  transcript: 'budget:transcript',
  breakdown: 'budget:breakdown',
} as const;
