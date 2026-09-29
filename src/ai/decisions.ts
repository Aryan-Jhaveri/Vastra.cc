import { z } from 'zod'
import { generateJSONWithUsage, providerForModel } from './client.js'
import { computeWholesaleCostDetailed, COST_UNITS_PER_USD, PROVIDER_REPORTED_COST, priceScheduleAt } from '../cost/tokenTable.js'
import { JEV_MODEL, typesafeEndpoint, type DecisionsProviderKind } from './decisionsProvider.js'
import { readJsonCapped, serverFetch } from './modelServers.js'
import { decisionsMaxTokens, fitDecisionsRequest } from './decisionFit.js'

export { JEV_MODEL, decisionsProviderInfo, isDecisionsConfigured, type DecisionsProviderInfo, type DecisionsProviderKind } from './decisionsProvider.js'

// ─── Decision provider (TypeSafe contract) ─────────────────────────────────────
//
// Pluggable since #332 so self-hosters can choose their model (#315). One
// contract, TypeSafe's state + named Noul/Choice/Score questions, served by:
//   - 'openrouter' (default): Jev on OpenRouter's /api/alpha/decisions, funded
//     by the master key, ZDR hardcoded. The rest of this header applies to it.
//   - 'typesafe': any TypeSafe-compatible endpoint the operator runs, e.g.
//     CLM-8B's clm-serve (#351). DECISIONS_URL (full endpoint URL),
//     DECISIONS_API_KEY and DECISIONS_MODEL are optional.
//   - 'llm': Noul questions scored by any chat model through the normal client
//     (a Gemini id, a vendor/ OpenRouter id, or local/ OpenAI-compatible, #289).
//     Set DECISIONS_MODEL. Choice/Score questions aren't supported there, so
//     callers fall back exactly as they do on an HTTP error.
// Instance-level config only; users never choose a URL (SSRF).
//
// ─── OpenRouter /api/alpha/decisions client (Jev) ──────────────────────────────
//
// Phase 1 of the Jev decision-layer rollout (issue #275). Thin HTTP client for
// OpenRouter's native decisions endpoint, which preserves TypeSafe's calibrated
// `answers[qid].{choice|noul|score, confidence, probabilities}` shape.
//
// Invariants (issue #275 + #276, land with the code):
//   - Uses MASTER_OPENROUTER_KEY only (the admin fallback). Jev is a free task;
//     per-user OpenRouter keys are never touched (CLAUDE.md § "Per-user OpenRouter
//     keys"). Fails closed with a clear error if the env var is unset.
//   - Hardcodes `provider: { zdr: true }` on every request. Non-negotiable.
//   - Defensive rail: rejects any state field whose key starts with `user_`
//     before the fetch call. Prevents leaking identifiers to a third-party
//     processor (GDPR § data minimization).
//
// Jev stays the hosted default (decided 2026-09-23, see
// notes/ai-generated/jev-integration-plan.md); the other providers exist for
// the open-source / self-host build.

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

/**
 * The master OpenRouter key that funds Jev calls. Resolved at call time (not
 * module load) so tests that vary env bindings via vi.resetModules + dynamic
 * import pick up fresh values. Mirrors client.ts's `MASTER_OPENROUTER_KEY`.
 */
function resolveMasterKey(): string {
  const key = process.env.OPENROUTER_API_KEY ?? ''
  if (!key) {
    throw new Error(
      '[decisions] OPENROUTER_API_KEY (MASTER_OPENROUTER_KEY) is not set — ' +
      'Jev decisions endpoint requires the master key. Suggest/discover are ' +
      'free tasks and never use per-user OpenRouter keys (CLAUDE.md § Per-user ' +
      'OpenRouter keys).',
    )
  }
  return key
}

// ─── Request / response types ──────────────────────────────────────────────────

/** Text, a JSON object/array, or null — matches TypeSafe SDK `EntryType`. */
export type EntryType = string | Record<string, unknown> | unknown[] | null

/** A yes/no question. */
export interface NoulQuestion {
  type: 'noul'
  instructions?: EntryType
  criteria?: { true?: EntryType; false?: EntryType } | null
}
/** Labels mapped to descriptions. */
export type ChoiceCriteria = Record<string, EntryType>
/** A question that selects between named alternatives. */
export interface ChoiceQuestion {
  type: 'choice'
  instructions?: EntryType
  criteria: ChoiceCriteria
}
/** An ordered rubric (≥2 entries). */
export type ScoreCriteria = [EntryType, EntryType, ...EntryType[]]
export interface ScoreQuestion {
  type: 'score'
  instructions?: EntryType
  criteria: ScoreCriteria
}
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
export type DecisionsQuestions = Record<string, DecisionQuestion>

// ─── Native TypeSafe answer shapes (preserved by OpenRouter) ────────────────────

export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability of a yes answer, 0–1. */
  readonly noul: number
}
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Record<string, number>
}
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
  readonly probabilities: Record<string, number>
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

// ─── Zod validation of the parsed response ─────────────────────────────────────

const NoulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
})
const ChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
})
const ScoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
})
const AnswerSchema = z.discriminatedUnion('type', [NoulAnswerSchema, ChoiceAnswerSchema, ScoreAnswerSchema])

const UsageSchema = z.object({
  cost: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
})

const DecisionsResponseSchema = z.object({
  answers: z.record(z.string(), AnswerSchema).default({}),
  usage: UsageSchema.default({}),
  model: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  provider: z.unknown().optional(),
})

export interface DecisionsResult {
  /** Answers keyed by question name, preserving each question's native shape. */
  answers: Record<string, DecisionAnswer>
  /**
   * USD cost and token counts for ai_calls. `cost` is null when unknown
   * (OpenRouter omitted it, or an unpriced llm model), never a silent 0 (#345).
   */
  usage: { cost: number | null; inputTokens: number; outputTokens: number }
  /** ai_calls.price_schedule_id for `usage.cost` (#344); absent when the cost is unknown. */
  priceScheduleId?: string
  model: string | null
  id: string | null
}

// ─── Defensive rail ─────────────────────────────────────────────────────────────

/**
 * Reject any state field whose key starts with `user_` before the request fires.
 * Prevents `user_id` / `user_name` / `user_email` from leaking into a third-party
 * processor's payload (issue #276 § "Code invariants"). Only inspects object
 * state; string/null state has no keys.
 */
function assertStateSafe(state: EntryType): void {
  if (state === null || typeof state !== 'object') return
  if (Array.isArray(state)) return // arrays have no string keys to leak
  for (const key of Object.keys(state as Record<string, unknown>)) {
    if (key.startsWith('user_')) {
      throw new Error(
        `[decisions] refusing to send state field "${key}" — keys starting ` +
        'with `user_` are blocked to prevent leaking user identifiers to the ' +
        'Jev/TypeSafe processor (issue #276 § Code invariants).',
      )
    }
  }
}

// ─── Public client ─────────────────────────────────────────────────────────────

export interface GenerateDecisionsOptions {
  /** Abort the in-flight fetch. */
  signal?: AbortSignal
  /** Per-request timeout. Default 30s (Jev is ~85× faster than Gemini Flash). */
  timeoutMs?: number
}

/**
 * Send state + named questions to the configured decision provider and return
 * the native TypeSafe answer shape. Mirrors the export style of
 * `generateText` / `generateJSON` in `src/ai/client.ts`.
 *
 * @throws if no provider is configured, if state contains a `user_*` key, on
 *         any non-2xx response, or for question types the provider can't
 *         answer. Callers treat every throw the same way (their fallback).
 */
export async function generateDecisions(
  state: EntryType,
  questions: DecisionsQuestions,
  opts: GenerateDecisionsOptions = {},
): Promise<DecisionsResult> {
  if (!questions || Object.keys(questions).length === 0) {
    throw new Error('[decisions] questions must be a non-empty object keyed by question name')
  }
  assertStateSafe(state)
  const kind = (process.env.DECISIONS_PROVIDER?.trim() || 'openrouter') as DecisionsProviderKind
  if (kind === 'typesafe') return typesafeDecisions(state, questions, opts)
  if (kind === 'llm') return llmDecisions(state, questions)
  if (kind !== 'openrouter') throw new Error(`[decisions] unknown DECISIONS_PROVIDER "${kind}"`)
  return openRouterDecisions(state, questions, opts)
}

async function openRouterDecisions(
  state: EntryType,
  questions: DecisionsQuestions,
  opts: GenerateDecisionsOptions,
): Promise<DecisionsResult> {
  const bearerKey = resolveMasterKey()

  const body = {
    model: JEV_MODEL,
    state,
    questions,
    // Non-negotiable: instruct the upstream provider (TypeSafe) not to retain
    // the request. Hardcoded on every call — no override path.
    provider: { zdr: true },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000)
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

  let res: Response
  try {
    res = await fetch(DECISIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(
      new Error(`[decisions] OpenRouter decisions HTTP ${res.status}: ${text.slice(0, 300)}`),
      { status: res.status },
    )
  }

  return parseDecisionsResponse(await res.json(), null, questions)
}

/**
 * Give each answer its `type`. OpenRouter's Jev response carries it; CLM's
 * `clm-serve` returns bare `{ noul }` / `{ choice, probabilities, confidence }`
 * objects, which the discriminated union would otherwise reject wholesale.
 * The type comes from the question that was asked, never from the answer's
 * shape. A missing confidence falls back to the top probability.
 */
function withAnswerTypes(json: unknown, questions: DecisionsQuestions): unknown {
  if (!json || typeof json !== 'object') return json
  const body = json as Record<string, unknown>
  if (!body.answers || typeof body.answers !== 'object') return json
  const answers: Record<string, unknown> = {}
  for (const [id, raw] of Object.entries(body.answers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const answer = { ...(raw as Record<string, unknown>) }
    if (answer.type === undefined) {
      const asked = questions[id]
      if (!asked) continue // untyped and not asked: nothing to type it from
      answer.type = asked.type
    }
    if (answer.type !== 'noul' && answer.confidence === undefined && answer.probabilities && typeof answer.probabilities === 'object') {
      const probs = Object.values(answer.probabilities as Record<string, unknown>).filter((p): p is number => typeof p === 'number')
      if (probs.length) answer.confidence = Math.max(...probs)
    }
    answers[id] = answer
  }
  return { ...body, answers }
}

function parseDecisionsResponse(json: unknown, costWhenMissing: number | null, questions: DecisionsQuestions): DecisionsResult {
  const parsed = DecisionsResponseSchema.parse(withAnswerTypes(json, questions))
  // A reported cost is the provider's bill; the fallback is our own rule (e.g. free own hardware).
  const priceScheduleId = parsed.usage.cost != null
    ? PROVIDER_REPORTED_COST
    : costWhenMissing != null ? priceScheduleAt().id : undefined
  return {
    answers: parsed.answers as Record<string, DecisionAnswer>,
    usage: {
      cost: parsed.usage.cost ?? costWhenMissing,
      inputTokens: parsed.usage.input_tokens ?? 0,
      outputTokens: parsed.usage.output_tokens ?? 0,
    },
    ...(priceScheduleId ? { priceScheduleId } : {}),
    model: parsed.model ?? null,
    id: parsed.id ?? null,
  }
}

const TYPESAFE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
let trimWarned = false

/**
 * Any TypeSafe-compatible endpoint the operator runs (e.g. CLM-8B's
 * clm-serve, #351). Runs under the decisions server's in-flight limit
 * (DECISIONS_MAX_CONCURRENCY), and fits the state and each question into
 * DECISIONS_MAX_TOKENS first so the server never truncates them itself.
 */
async function typesafeDecisions(
  state: EntryType,
  questions: DecisionsQuestions,
  opts: GenerateDecisionsOptions,
): Promise<DecisionsResult> {
  typesafeEndpoint() // a clear setup error before anything else
  const model = process.env.DECISIONS_MODEL?.trim()
  const fitted = fitDecisionsRequest(state, questions, decisionsMaxTokens())
  if (fitted.trimmed > 0 && !trimWarned) {
    trimWarned = true
    console.warn(`[decisions] shrank ${fitted.trimmed} state/question text(s) to fit DECISIONS_MAX_TOKENS=${decisionsMaxTokens()} (warned once)`)
  }
  const res = await serverFetch('decisions', '', {
    body: { ...(model ? { model } : {}), state: fitted.state, questions: fitted.questions },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  })
  // The operator's own server: no provider bill unless it reports one.
  return parseDecisionsResponse(await readJsonCapped(res, TYPESAFE_MAX_RESPONSE_BYTES, 'Decisions server'), 0, questions)
}

function entryText(entry: EntryType | undefined): string {
  if (entry === undefined || entry === null) return ''
  return typeof entry === 'string' ? entry : JSON.stringify(entry)
}

/**
 * Noul questions scored by a chat model. The model returns one yes-probability
 * per question id. Less calibrated than a trained decision model, which is why
 * it's opt-in, but it lets any self-hoster use features built on Nouls.
 */
async function llmDecisions(state: EntryType, questions: DecisionsQuestions): Promise<DecisionsResult> {
  const model = process.env.DECISIONS_MODEL?.trim()
  if (!model) throw new Error('[decisions] DECISIONS_PROVIDER=llm needs DECISIONS_MODEL')
  const ids = Object.keys(questions)
  for (const id of ids) {
    if (questions[id].type !== 'noul') throw new Error('[decisions] the llm provider answers noul questions only')
  }
  const lines = ids.map(id => {
    const q = questions[id] as NoulQuestion
    const yes = entryText(q.criteria?.true)
    const no = entryText(q.criteria?.false)
    return `- ${id}: ${entryText(q.instructions)}${yes ? ` (yes means: ${yes})` : ''}${no ? ` (no means: ${no})` : ''}`
  })
  const prompt = `You answer yes/no questions about the state below with calibrated probabilities.

State:
${entryText(state)}

Questions (id: question):
${lines.join('\n')}

Return ONLY a JSON object mapping every question id to the probability (0 to 1) that the answer is yes, e.g. {"${ids[0]}": 0.8}.`
  const { data, usage } = await generateJSONWithUsage<Record<string, unknown>>(prompt, undefined, model)
  const answers: Record<string, DecisionAnswer> = {}
  for (const id of ids) {
    const value = data?.[id]
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`[decisions] llm answer missing for "${id}"`)
    answers[id] = { type: 'noul', noul: Math.min(1, Math.max(0, value)) }
  }
  const { cost, known, priceScheduleId } = computeWholesaleCostDetailed(providerForModel(model), model, usage)
  return {
    answers,
    usage: { cost: known ? cost / COST_UNITS_PER_USD : null, inputTokens: usage.tokensIn, outputTokens: usage.tokensOut },
    ...(known ? { priceScheduleId } : {}),
    model,
    id: null,
  }
}
