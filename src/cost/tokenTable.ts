export type AiTask =
  | 'categorize'
  | 'detect'
  | 'ocr'
  | 'suggest'
  | 'suggest_reshuffle'
  | 'make_pretty'
  | 'tryon'
  | 'embed_item'
  | 'embed_outfit'
  | 'embed_share'
  | 'embed_backfill_manual'
  | 'embed_reconcile'
  | 'discover'
  | 'inspiration'
  | 'shop_rank'
  | 'chat_turn'
  | 'related'

/** Vastra tokens charged per action (from vastra-token-economics-and-billing.md). */
export const TOKEN_COST: Record<AiTask, number> = {
  categorize: 0,
  detect: 2,
  ocr: 1,
  suggest: 1,
  // Reshuffles are free for the first 25/day, then 1 token — the dynamic
  // portion is computed at the route from ai_calls history. The static value
  // stays 0 so background/non-route callers never auto-charge.
  suggest_reshuffle: 0,
  make_pretty: 16,
  tryon: 16,
  embed_item: 0,
  embed_outfit: 0,
  embed_share: 0,
  embed_backfill_manual: 0,
  embed_reconcile: 0,
  // First active-mode generation = 2 (inspiration + closet-match phases).
  // Regenerate = 1, shared mode = 0 — both resolved at the route.
  discover: 2,
  inspiration: 0,
  // Jev ranking of the Related shop row (#324) — free, master-key funded.
  shop_rank: 0,
  // Agent chat turn (#318). The first 10 turns/day are free, then 1 token per
  // turn, resolved by the loop from ai_calls history (acquireTurnLease). The
  // static value stays 0 so no other caller auto-charges.
  chat_turn: 0,
  // "Find related" in detail cards (#332) — free, capped per user per day.
  related: 0,
}

export function tokenCost(task: AiTask): number {
  return TOKEN_COST[task]
}

// ─── Per-model wholesale pricing ───────────────────────────────────────────────
//
// Cost unit: ai_calls.wholesale_cost_cents_x100 holds USD × 100,000 (i.e.
// thousandths of a cent), despite its name. Every writer (per-token prices
// below, the Jev path in instrumented.ts) already used this unit; readers
// must divide by COST_UNITS_PER_USD, never by 10,000.
export const COST_UNITS_PER_USD = 100_000

export interface ModelPrice {
  inputPerMTokensX100: number
  outputPerMTokensX100: number
  flatPerCallX100?: number
}

/**
 * A versioned set of wholesale rates (#344). A shipped schedule is immutable:
 * new or corrected rates go in a NEW schedule with a later `effectiveFrom`,
 * so every ai_calls row can name the exact rates behind its estimate and old
 * estimates are never re-priced implicitly. test/cost/priceSchedules.test.ts
 * pins each shipped schedule's contents.
 */
export interface PriceSchedule {
  id: string
  /** YYYY-MM-DD (UTC). The schedule applies to calls from this day on. */
  effectiveFrom: string
  /** Where the rates came from. */
  source: string
  prices: Readonly<Record<string, Readonly<ModelPrice>>>
  /**
   * Gemini models Vertex bills at the Developer API rate (#158), so
   * `vertex:<model>` reuses the `gemini:<model>` row. Explicit (#345): a Gemini
   * model reached through Vertex with no entry here is unpriced, never silently
   * borrowed from a same-named row.
   */
  vertexGeminiEquivalents: readonly string[]
}

/** ai_calls.price_schedule_id for a cost the provider reported (e.g. OpenRouter usage.cost), not a rate estimate. */
export const PROVIDER_REPORTED_COST = 'provider-reported'

const SCHEDULE_2026_06_30_PRICES: Record<string, ModelPrice> = {
  // Gemini 2.5 Flash — https://ai.google.dev/gemini-api/docs/pricing — verified 2026-06-16
  // $0.30/M input → 30000, $2.50/M output → 250000 (COST_UNITS_PER_USD per 1M tokens)
  'gemini:gemini-2.5-flash':              { inputPerMTokensX100: 30000,  outputPerMTokensX100: 250000 },
  'gemini:gemini-flash-latest':           { inputPerMTokensX100: 30000,  outputPerMTokensX100: 250000 },
  // Gemini 2.5 Flash Image (Nano Banana) — the IMAGE_GEN_MODEL code default.
  // $0.30/M input, $30/M output; 1290 tokens/image ≈ $0.039 (matches
  // prototypes/lib/pricing.json "gemini-2.5-flash-image": 0.039 per image).
  'gemini:gemini-2.5-flash-image':        { inputPerMTokensX100: 30000,   outputPerMTokensX100: 3_000_000 },
  // Nano Banana 2 Lite — Standard tier, verified 2026-06-30
  // Google blog: blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni-flash-nano-banana-2-lite/
  // Input $0.25/M, Output image $30/M → ~$0.034 per 1K image (1120 output tokens/image)
  'gemini:gemini-3.1-flash-lite-image':   { inputPerMTokensX100: 25000,   outputPerMTokensX100: 3_000_000 },
  // Nano Banana 2 (3.1 Flash Image Preview) — was flat $0.0039 (bug, 10× under), now per-token
  // Input $0.50/M, Output image $60/M → ~$0.067 per 1K image
  'gemini:gemini-3.1-flash-image-preview':{ inputPerMTokensX100: 50000,   outputPerMTokensX100: 6_000_000 },
  // Nano Banana Pro (3 Pro Image) — Standard tier, verified 2026-06-30
  // Input $2.00/M, Output image $120/M → ~$0.134 per 1K image, $0.24 per 4K image
  'gemini:gemini-3-pro-image':            { inputPerMTokensX100: 200000,  outputPerMTokensX100: 12_000_000 },
  // Vertex multimodalembedding@001 — flat per-call — verified 2026-06-16
  // $0.0001 per call = 10 units. Was 1 (priced in USD × 10,000 by mistake).
  'vertex:multimodalembedding@001':       { inputPerMTokensX100: 0,      outputPerMTokensX100: 0, flatPerCallX100: 10 },
  // Gemini embedding-001 — $0.15/M input — verified 2026-06-16
  'gemini:gemini-embedding-001':          { inputPerMTokensX100: 15000,  outputPerMTokensX100: 0 },
  // OpenRouter Mistral Small 3.2 — verified 2026-06-16. Key matches the full
  // model id sent to OpenRouter (TEXT_MODEL default), so the lookup hits.
  'openrouter:mistralai/mistral-small-3.2-24b-instruct': { inputPerMTokensX100: 5000, outputPerMTokensX100: 15000 },
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** Every shipped schedule, oldest first. Append; never edit a shipped entry. */
export const PRICE_SCHEDULES: readonly PriceSchedule[] = deepFreeze([
  {
    id: 'ps-2026-06-30',
    effectiveFrom: '2026-06-30',
    source: 'Provider pricing pages as noted per row (Gemini/Vertex verified 2026-06-16 and 2026-06-30, OpenRouter 2026-06-16).',
    prices: SCHEDULE_2026_06_30_PRICES,
    vertexGeminiEquivalents: [
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-2.5-flash-image',
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-image-preview',
      'gemini-3-pro-image',
      'gemini-embedding-001',
    ],
  },
])

/** The schedule in effect at `at` (ms): the latest one whose effectiveFrom has started. */
export function priceScheduleAt(at: number = Date.now(), schedules: readonly PriceSchedule[] = PRICE_SCHEDULES): PriceSchedule {
  const day = new Date(at).toISOString().slice(0, 10)
  let current = schedules[0]
  for (const schedule of schedules) if (schedule.effectiveFrom <= day) current = schedule
  return current
}

export function getPriceSchedule(id: string): PriceSchedule | undefined {
  return PRICE_SCHEDULES.find(s => s.id === id)
}

// Providers with no provider bill by construction: 'self' is the operator's
// own hardware (#289), 'mocked' never leaves the process.
const FREE_PROVIDERS: ReadonlySet<string> = new Set(['self', 'mocked'])

/** The price row for a provider/model under a schedule, 'free', or null when unpriced. */
export function priceFor(provider: string, model: string, schedule: PriceSchedule = priceScheduleAt()): Readonly<ModelPrice> | 'free' | null {
  if (FREE_PROVIDERS.has(provider)) return 'free'
  const exact = schedule.prices[`${provider}:${model}`]
  if (exact) return exact
  if (provider === 'vertex' && schedule.vertexGeminiEquivalents.includes(model)) return schedule.prices[`gemini:${model}`] ?? null
  return null
}

export function isPriced(provider: string, model: string): boolean {
  return priceFor(provider, model) !== null
}

const COST_WARNED = new Set<string>()

export interface WholesaleCost {
  cost: number
  known: boolean
  /** The schedule the estimate came from; stored as ai_calls.price_schedule_id. */
  priceScheduleId: string
}

/**
 * Wholesale cost in COST_UNITS_PER_USD units, whether it is known, and the
 * schedule used. An unpriced model reports known=false (#345) instead of a
 * cost of 0 that reads as verified-free in ai_calls and margin reports.
 */
export function computeWholesaleCostDetailed(
  provider: string,
  model: string,
  usage: { tokensIn: number; tokensOut: number },
  schedule: PriceSchedule = priceScheduleAt(),
): WholesaleCost {
  const priceScheduleId = schedule.id
  const price = priceFor(provider, model, schedule)
  if (price === 'free') return { cost: 0, known: true, priceScheduleId }
  if (!price) {
    const key = `${provider}:${model}`
    if (!COST_WARNED.has(key)) {
      COST_WARNED.add(key)
      console.warn(`[billing] wholesale cost not configured for "${key}" in ${schedule.id} — recorded as unknown`)
    }
    return { cost: 0, known: false, priceScheduleId }
  }
  if (price.flatPerCallX100 !== undefined) return { cost: price.flatPerCallX100, known: true, priceScheduleId }
  return {
    cost: Math.round((usage.tokensIn * price.inputPerMTokensX100 + usage.tokensOut * price.outputPerMTokensX100) / 1_000_000),
    known: true,
    priceScheduleId,
  }
}

export function computeWholesaleCost(provider: string, model: string, usage: { tokensIn: number; tokensOut: number }): number {
  return computeWholesaleCostDetailed(provider, model, usage).cost
}
