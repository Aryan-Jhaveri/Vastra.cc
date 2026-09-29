import { nanoid } from 'nanoid'
import type { AiTask, WholesaleCost } from '../cost/tokenTable.js'
import { computeWholesaleCostDetailed, isPriced } from '../cost/tokenTable.js'
import { generateMessages, providerForModel, streamMessages } from './client.js'
import { isLocalModel } from './localModel.js'
import { usageFromError, type AgentCallIdentity, type MessageRequest, type MessageResponse, type ModelEvent } from './messages.js'
import type { UsageMetadata } from './client.js'
import type { DecisionsResult } from './decisions.js'
import { decisionsProviderInfo, JEV_MODEL } from './decisionsProvider.js'
import { aiCalls } from '../db/schema.js'
import { isMockEmbeddings } from '../storage/embeddings.js'
import { getBilling, hostedHooks } from '../hostedHooks.js'
import { insertAiCall } from './aiCalls.js'
import { UnpricedModelError } from '../cost/errors.js'
import { isHostedMode } from '../hostedMode.js'

// `local/` ids (#289) hit the operator's own server: no per-user key to load.
/**
 * Key for an OpenRouter-routed call. Hosted: the user's own minted key, which
 * backs the wallet's spend limits. Self-host has no per-user keys (nothing is
 * minted at signup), so every call uses the operator's OPENROUTER_API_KEY —
 * their account, their bill. Fails closed in both modes when there's no key.
 */
function isOpenRouterModel(modelId: string): boolean {
  return modelId.includes('/') && !isLocalModel(modelId)
}

export interface InstrumentedCall<T> extends AgentCallIdentity {
  userId: string
  task: AiTask
  /** Optional override; normally derived from `model` via providerForModel().
   *  Deliberately `string` (not narrowed to `'openrouter'|'vertex'|'gemini'`)
   *  so admin/manual overrides can pass arbitrary provider labels for billing. */
  provider?: string
  model: string
  expectedBilledTokens: number
  mocked?: boolean
  itemId?: string
  outfitId?: string
  /** Scheduled job that triggered this call (#189). */
  jobId?: string
  /** Called after the ai_calls row is written — use for post-hoc backlinks.
   *  Fires on SUCCESS only; failed calls still write an ai_calls row but skip this hook. */
  onCallRecorded?: (callId: string) => void
  /** Read on failure: true keeps the charge instead of refunding it, because
   *  the user already received output (#328 threat #3). */
  chargeOnFailure?: () => boolean
  call: (ctx: {
    openrouterKey?: string
    /** Cumulative provider usage, not a delta; retained if the call later fails. */
    reportUsage: (usage: UsageMetadata) => void
  }) => Promise<{ result: T; usage?: { tokensIn?: number; tokensOut?: number } }>
}

export function isMockImageGen(): boolean {
  return process.env.MOCK_AI_IMAGE_GEN === 'true'
}

export interface InstrumentedCost {
  billedTokens: number
  wholesaleCostCentsX100: number
  tokensIn: number
  tokensOut: number
}

/** errorMessage prefix of a failed call that still delivered output (and is
 *  charged). Chat counts these turns against the daily free allowance. */
export const PARTIAL_OUTPUT_ERROR_PREFIX = 'partial_output: '

function truncate(msg: unknown, max = 500): string | null {
  if (!msg) return null
  const s = typeof msg === 'string' ? msg : String((msg as Error).message ?? msg)
  return s.length > max ? s.slice(0, max - 3) + '...' : s
}

function buildCost(provider: string, model: string, usage?: { tokensIn?: number; tokensOut?: number }): WholesaleCost {
  return computeWholesaleCostDetailed(provider, model, { tokensIn: usage?.tokensIn ?? 0, tokensOut: usage?.tokensOut ?? 0 })
}

export async function runInstrumented<T>(input: InstrumentedCall<T>): Promise<T> {
  return (await runInstrumentedDetailed(input)).result
}

export async function runInstrumentedDetailed<T>(input: InstrumentedCall<T>): Promise<{ result: T; cost: InstrumentedCost }> {
  const identity = {
    runId: input.runId ?? null, turnId: input.turnId ?? null,
    stepId: input.stepId ?? null, toolCallId: input.toolCallId ?? null,
  }
  // Drizzle silently omits unknown columns. Never lose supplied identities on
  // an installation without the corresponding schema integration.
  for (const [key, value] of Object.entries(identity)) {
    if (value !== null && !(key in aiCalls)) throw new Error(`ai_calls schema requires ${key} before agent calls are enabled`)
  }
  const ledgerMetadata = { task: input.task, ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== null)) }
  if (!Number.isSafeInteger(input.expectedBilledTokens) || input.expectedBilledTokens < 0) throw new Error('Expected billed tokens must be a nonnegative integer')
  const mocked = input.mocked ?? false
  const billed = mocked ? 0 : input.expectedBilledTokens
  const effectiveProvider = mocked ? 'mocked' : (input.provider ?? providerForModel(input.model))
  // #315 — billing is the hosted wallet when HOSTED_MODE is on, a no-op
  // (no reservation, no debit) when self-hosted. ai_calls rows are still
  // recorded in both modes for observability.
  const billing = getBilling()
  let reservationId: string | null = null
  let settled = false
  let usage: { tokensIn?: number; tokensOut?: number } | undefined
  const start = Date.now()
  const callId = nanoid()
  const baseRow = {
    id: callId, userId: input.userId, itemId: input.itemId ?? null,
    outfitId: input.outfitId ?? null, jobId: input.jobId ?? null,
    ...identity, task: input.task, provider: effectiveProvider, model: input.model,
  }
  try {
    // #345 — a call that charges the user's wallet needs a known wholesale
    // price, or margins go blind. Refuse before any key lookup, reservation or
    // provider spend. Self-host never charges (no-op billing), so an operator's
    // own model choice is recorded as unknown cost instead of refused.
    if (!mocked && billed > 0 && isHostedMode() && !isPriced(effectiveProvider, input.model)) {
      throw new UnpricedModelError(effectiveProvider, input.model)
    }
    let openrouterKey: string | undefined
    if (!mocked && isOpenRouterModel(input.model)) {
      openrouterKey = hostedHooks().resolveOpenRouterKey(input.userId)
    }
    if (billed > 0) reservationId = billing.canSpend(input.userId, billed, ledgerMetadata)
    const response = await input.call({ openrouterKey, reportUsage: value => { usage = { ...value } } })
    usage = response.usage ?? usage
    const latencyMs = Date.now() - start
    const { cost, known, priceScheduleId } = buildCost(effectiveProvider, input.model, usage)
    const tokensIn = usage?.tokensIn ?? 0
    const tokensOut = usage?.tokensOut ?? 0

    const row = {
      ...baseRow,
      tokensIn,
      tokensOut,
      wholesaleCostCentsX100: cost,
      costKnown: known ? 1 : 0,
      priceScheduleId,
      billedTokens: billed,
      latencyMs,
      success: 1,
      parseSuccess: 1,
      createdAt: Date.now(),
    }
    billing.debit(input.userId, row, reservationId)
    settled = true

    input.onCallRecorded?.(callId)

    return { result: response.result, cost: { billedTokens: billed, wholesaleCostCentsX100: cost, tokensIn, tokensOut } }
  } catch (err) {
    // A backlink hook failure must not refund a successfully recorded provider call.
    if (settled) throw err
    usage = usageFromError(err) ?? usage
    const latencyMs = Date.now() - start
    // No usage → nothing was consumed: a cost of 0 that no schedule produced.
    const failedCost = usage ? buildCost(effectiveProvider, input.model, usage) : { cost: 0, known: true, priceScheduleId: null }
    let partial = false
    try { partial = !!input.chargeOnFailure?.() } catch { /* treat as no output */ }
    const failedRow = {
      ...baseRow,
      tokensIn: usage?.tokensIn ?? 0,
      tokensOut: usage?.tokensOut ?? 0,
      wholesaleCostCentsX100: failedCost.cost,
      costKnown: failedCost.known ? 1 : 0,
      priceScheduleId: failedCost.priceScheduleId,
      billedTokens: 0,
      latencyMs,
      success: 0,
      parseSuccess: 0,
      errorMessage: truncate(err),
      createdAt: Date.now(),
    }

    // Output already reached the user: the charge stands, no refund.
    if (partial) {
      billing.debit(input.userId, {
        ...failedRow,
        billedTokens: reservationId ? billed : 0,
        errorMessage: truncate(`${PARTIAL_OUTPUT_ERROR_PREFIX}${failedRow.errorMessage ?? 'failed'}`),
      }, reservationId)
      throw err
    }

    try {
      insertAiCall(failedRow)
    } finally {
      if (reservationId) {
        billing.refund(input.userId, billed, reservationId, {
          ...ledgerMetadata, reason: 'provider_failure',
        })
      }
    }
    throw err
  }
}

export type InstrumentedMessageCall = Omit<InstrumentedCall<MessageResponse>, 'call' | 'provider' | 'mocked'> & {
  request: MessageRequest
}

/** One model turn only. Declared tools are data, never callbacks or executable tools. */
export function generateMessagesInstrumented(input: InstrumentedMessageCall): Promise<MessageResponse> {
  return runInstrumented({
    ...input,
    mocked: false,
    provider: undefined,
    call: async ({ openrouterKey }) => {
      const result = await generateMessages(input.request, input.model, openrouterKey)
      return { result, usage: result.usage }
    },
  })
}

/**
 * Drives the stream to completion inside the billing boundary. onEvent is for
 * presentation only, not tool execution. Only the resolved response is final
 * (and billed); disconnects must abort request.signal. Partial events are not
 * executable. Throwing from onEvent cancels the provider; the call is refunded
 * unless text was already handed to onEvent, in which case the charge stands
 * (#328 threat #3: no refund for aborting after output).
 */
export function streamMessagesInstrumented(input: InstrumentedMessageCall & {
  onEvent: (event: Exclude<ModelEvent, { type: 'complete' }>) => void | Promise<void>
}): Promise<MessageResponse> {
  let deliveredText = false
  return runInstrumented({
    ...input,
    mocked: false,
    provider: undefined,
    chargeOnFailure: () => deliveredText,
    call: async ({ openrouterKey, reportUsage }) => {
      let result: MessageResponse | undefined
      for await (const event of streamMessages(input.request, input.model, openrouterKey)) {
        if (event.type === 'complete') {
          result = event.response
          reportUsage(result.usage)
        } else {
          if (event.type === 'usage') reportUsage(event.usage)
          await input.onEvent(event)
          if (event.type === 'text_delta' && event.text) deliveredText = true
          input.request.signal?.throwIfAborted()
        }
      }
      if (!result) throw new Error('Model stream ended without a completed response')
      return { result, usage: result.usage }
    },
  })
}

export function runEmbeddingInstrumented(input: AgentCallIdentity & {
  userId: string
  task: AiTask
  /** Optional override; normally derived from `model` via providerForModel().
   *  Kept as `string` (not narrowed to the providerForModel union) so admin
   *  tools and manual overrides can pass arbitrary provider labels for billing
   *  — computeWholesaleCost handles unknown providers gracefully. */
  provider?: string
  model: string
  mocked?: boolean
  fn: () => Promise<void>
  tokensIn?: number
  tokensOut?: number
}): void {
  const mocked = input.mocked ?? isMockEmbeddings()
  runInstrumented<void>({
    runId: input.runId,
    turnId: input.turnId,
    stepId: input.stepId,
    toolCallId: input.toolCallId,
    userId: input.userId,
    task: input.task,
    provider: input.provider,
    model: input.model,
    expectedBilledTokens: 0,
    mocked,
    call: async () => {
      await input.fn()
      return { result: undefined as void, usage: { tokensIn: input.tokensIn ?? 0, tokensOut: input.tokensOut ?? 0 } }
    },
  }).catch(() => {})
}

// ─── Jev decisions instrumentation (#275) ──────────────────────────────────────
//
// runInstrumentedDecisions records an ai_calls row for a Jev `/api/alpha/decisions`
// call. Unlike runInstrumented, the cost comes straight from the provider's
// `usage.cost` (actual USD reported by OpenRouter), not a token-based estimate
// via computeWholesaleCost. Jev is a free task: billedTokens=0, no wallet
// reservation, no per-user OpenRouter key (the master key funds every call —
// CLAUDE.md § "Per-user OpenRouter keys").
//
// Cost unit convention: `wholesale_cost_cents_x100` stores USD × 100,000
// (verified against tokenTable.test.ts: $0.00155 → 155). Jev's reported
// `usage.cost` is in real USD, so we multiply by 100,000 to land in the same
// unit the token-based path produces, keeping swallow/aggregate metrics
// comparable across providers.

// Rows are labelled with the active decision provider (#332): 'typesafe' /
// Jev by default, 'self' for an operator's TypeSafe server, or the chat
// model's own provider for DECISIONS_PROVIDER=llm.

export interface InstrumentedDecisionsCall extends AgentCallIdentity {
  userId: string
  task: AiTask
  itemId?: string
  outfitId?: string
  jobId?: string
  /** Fires on SUCCESS only, after the ai_calls row is written. */
  onCallRecorded?: (callId: string) => void
  /** Runs the Jev decisions call and returns the native TypeSafe result. */
  call: () => Promise<DecisionsResult>
}

export async function runInstrumentedDecisions(input: InstrumentedDecisionsCall): Promise<DecisionsResult> {
  const identity = {
    runId: input.runId ?? null, turnId: input.turnId ?? null,
    stepId: input.stepId ?? null, toolCallId: input.toolCallId ?? null,
  }
  for (const [key, value] of Object.entries(identity)) {
    if (value !== null && !(key in aiCalls)) throw new Error(`ai_calls schema requires ${key} before agent calls are enabled`)
  }
  const callId = nanoid()
  const start = Date.now()
  const labels = decisionsProviderInfo() ?? { provider: 'typesafe', model: JEV_MODEL }
  const baseRow = {
    id: callId, userId: input.userId, itemId: input.itemId ?? null,
    outfitId: input.outfitId ?? null, jobId: input.jobId ?? null,
    ...identity, task: input.task, provider: labels.provider, model: labels.model,
  }
  try {
    const result = await input.call()
    const latencyMs = Date.now() - start
    const costUsd = result.usage.cost ?? 0
    // USD × 100,000 → wholesale_cost_cents_x100 unit (see file header note).
    const wholesaleCostCentsX100 = Math.round(costUsd * 100_000)
    insertAiCall({
      ...baseRow,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      wholesaleCostCentsX100,
      // OpenRouter reports the actual cost; without it the cost is unknown (#345).
      costKnown: result.usage.cost == null ? 0 : 1,
      priceScheduleId: result.priceScheduleId ?? null,
      billedTokens: 0,
      latencyMs,
      success: 1,
      parseSuccess: 1,
      createdAt: Date.now(),
    })
    input.onCallRecorded?.(callId)
    return result
  } catch (err) {
    const latencyMs = Date.now() - start
    const errorMessage = truncate(err)
    try {
      insertAiCall({
        ...baseRow,
        tokensIn: 0,
        tokensOut: 0,
        wholesaleCostCentsX100: 0,
        billedTokens: 0,
        latencyMs,
        success: 0,
        parseSuccess: 0,
        errorMessage,
        createdAt: Date.now(),
      })
    } catch {
      // never shadow the original error
    }
    throw err
  }
}
