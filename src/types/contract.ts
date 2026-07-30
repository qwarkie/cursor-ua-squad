// The one seam between the frontend and the backend. Every payload that crosses /api is
// described here, and these types must mirror the Pydantic models in backend/ exactly.
//
// RULES: one writer only — whoever owns the backend edits this file, everyone else reads it.
// FROZEN AT T+8. After that, changing a field here breaks someone else's screen mid-build;
// add a new optional field instead of renaming or removing an existing one.
//
// Mirrors:
//   HealthResponse  -> backend/main.py            Health
//   ItemReading     -> backend/vision_router.py   ItemReading      (VISION_SCHEMAS['item'])
//   Profile         -> backend/affordability.py   Profile
//   AssessRequest   -> backend/affordability.py   AssessRequest
//   AssessResponse  -> backend/affordability.py   AssessResponse
//
// The vision and search modules carry their own wire types (VisionState, GroundedAnswer);
// those are module contracts, not ours, and are imported from '@/lib/vision' / '@/lib/search'.

/** GET /api/health - mirrors `Health`. 503 with status "misconfigured" when env is missing. */
export interface HealthResponse {
  status: 'ok' | 'misconfigured';
  python: string;
  /** True when backend/.env exists. False is the usual reason a key looks "missing". */
  env_file: boolean;
  /** Names only. The backend never returns env values. */
  env_present: string[];
  env_missing: string[];
}

// ---------------------------------------------------------------------------
// Capture -> Intelligence
// ---------------------------------------------------------------------------

/** Closed list, because it is the grouping key for the statistics. Mirrors CATEGORIES. */
export type Category =
  | 'electronics'
  | 'transport'
  | 'home'
  | 'fashion'
  | 'food'
  | 'health'
  | 'entertainment'
  | 'tools'
  | 'other';

export const CATEGORIES: readonly Category[] = [
  'electronics',
  'transport',
  'home',
  'fashion',
  'food',
  'health',
  'entertainment',
  'tools',
  'other',
];

/**
 * What the camera saw, priced. Comes back inside the vision module's `ExtractResult<T>`
 * from `POST /api/vision/extract` with `schema_name: 'item'`.
 */
export interface ItemReading {
  name: string;
  category: Category;
  brand: string;
  condition: 'new' | 'used' | 'unknown';
  estimated_price: number;
  currency: string;
  /** The model's own confidence, uncalibrated. Render it; never silently threshold on it. */
  price_confidence: number;
  price_basis: string;
  alternatives: string[];
}

// ---------------------------------------------------------------------------
// Intelligence -> Surface
// ---------------------------------------------------------------------------

/** The user's own monthly figures. One currency throughout — nothing is converted. */
export interface Profile {
  monthly_income: number;
  monthly_expenses: number;
  savings: number;
  /** ISO 4217, exactly three characters. */
  currency: string;
  /** 0..1 — share of disposable income this purchase may claim. */
  commit_share: number;
  /** Months of expenses that must stay untouched. */
  emergency_months: number;
}

/** POST /api/affordability/assess - what the client sends. */
export interface AssessRequest {
  profile: Profile;
  item_name: string;
  category: string;
  /** The price actually being tested — the model's estimate, or one the user edited. */
  price: number;
  price_basis: string;
}

export type Verdict = 'easy' | 'affordable' | 'stretch' | 'plan_it' | 'out_of_reach';

/** Every field is arithmetic on the request. Nothing here is model output. */
export interface AffordabilityMath {
  verdict: Verdict;
  disposable_income: number;
  monthly_capacity: number;
  share_of_income: number;
  share_of_disposable: number;
  months_to_save: number;
  work_hours: number;
  hourly_rate: number;
  spendable_savings: number;
  payable_from_savings: boolean;
  breaks_emergency_fund: boolean;
}

/** The model's half: the words only, reasoning over numbers it was handed. */
export interface Advice {
  headline: string;
  reasoning: string;
  action: string;
  tradeoff: string;
  alternatives: string[];
  risk: 'low' | 'medium' | 'high';
}

/** POST /api/affordability/assess - what the server returns. */
export interface AssessResponse {
  item_name: string;
  category: string;
  price: number;
  currency: string;
  math: AffordabilityMath;
  advice: Advice;
  /** Which model in the fallback chain actually answered. */
  model: string;
}

// ---------------------------------------------------------------------------
// Surface -> storage
// ---------------------------------------------------------------------------

/**
 * One row of history, stored as the `payload` of an item in collection `scans`
 * (`/api/items`, backend/store_router.py). The backend does not know this shape —
 * it stores opaque JSON — so the Zod schema in src/lib/records.ts is what validates it.
 */
export interface ScanRecord {
  item_name: string;
  category: Category | string;
  price: number;
  currency: string;
  verdict: Verdict;
  share_of_disposable: number;
  work_hours: number;
  months_to_save: number;
  headline: string;
  /** Epoch ms, set by the client at save time. */
  scanned_at: number;
}
