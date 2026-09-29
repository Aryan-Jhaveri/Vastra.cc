import { createHash } from 'crypto'
import { getAllItems, getAllOutfits, getCollection, getItem, getOutfit, getOutfitIdsInCollection, searchTokens } from '../db/queries.js'
import { generateDecisions, type DecisionsQuestions, type EntryType } from './decisions.js'
import { itemDecisionBlob, outfitDecisionBlob } from './decisionText.js'
import { runInstrumentedDecisions } from './instrumented.js'
import { isDecisionsConfigured } from './decisionsProvider.js'
import {
  claimRelated, finishRelated, lastRelated, relatedQuota,
  type RelatedHit, type RelatedKind, type RelatedQuota,
} from '../db/relatedRequests.js'
import type { AgentCallIdentity } from './messages.js'
import type { Item } from '../types/index.js'

// #332 / #279 — "Find related" for the Item, Outfit and Collection detail
// cards. One Noul per candidate, 32 per decision call, calls in parallel.
// Runs only when the user taps the magnifier; nothing here is scheduled.

export const RELATED_BATCH = 32
export const RELATED_MAX_CANDIDATES = 96
export const RELATED_ITEM_TOP = 8
export const RELATED_OUTFIT_TOP = 6
/** Collection fit threshold (nb23: sharper descriptions separate at ~0.6). */
export const RELATED_COLLECTION_THRESHOLD = 0.6

export class RelatedNotFoundError extends Error {
  constructor() { super('Not found'); this.name = 'RelatedNotFoundError' }
}

interface Candidate { id: string; blob: unknown }

export interface RelatedPlan {
  kind: RelatedKind
  state: EntryType
  candidates: Candidate[]
  question: string
  /** Changes whenever the anchor or any candidate changes: gates the saved result. */
  fingerprint: string
  pick: (scored: RelatedHit[]) => RelatedHit[]
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const outfitSignature = (o: { id: string; name: string; itemIds: string; occasion: string | null; tags: string | null; season: string | null }) =>
  [o.id, o.name, o.itemIds, o.occasion, o.tags, o.season]

/** Anchor + candidates for one find. Everything is loaded by (id, userId). */
export function relatedPlan(kind: RelatedKind, targetId: string, userId: string): RelatedPlan {
  if (kind === 'item') {
    const anchor = getItem(targetId, userId)
    if (!anchor) throw new RelatedNotFoundError()
    // Pairs come from other categories (a top gets bottoms, shoes...), most recent first.
    const pool = getAllItems(userId).filter(i => i.id !== anchor.id && i.category !== anchor.category)
      .slice(0, RELATED_MAX_CANDIDATES)
    return {
      kind,
      state: { anchor_item: itemDecisionBlob(anchor) },
      candidates: pool.map(i => ({ id: i.id, blob: itemDecisionBlob(i) })),
      question: 'Does this candidate item pair well with the anchor item in one outfit?',
      fingerprint: hash([anchor.id, anchor.updatedAt, pool.map(i => [i.id, i.updatedAt])]),
      pick: scored => scored.slice(0, RELATED_ITEM_TOP),
    }
  }

  const items = getAllItems(userId)
  const itemsById = new Map<string, Item>(items.map(i => [i.id, i]))
  const outfitCandidates = (exclude: Set<string>) => getAllOutfits(userId)
    .filter(o => !exclude.has(o.id))
    .map(o => ({ outfit: o, blob: outfitDecisionBlob(o, itemsById) }))
    .filter(c => c.blob.items.length > 0) // every item deleted: nothing to judge
    .slice(0, RELATED_MAX_CANDIDATES)
  const itemsSig = items.map(i => [i.id, i.updatedAt])

  if (kind === 'outfit') {
    const anchor = getOutfit(targetId, userId)
    if (!anchor) throw new RelatedNotFoundError()
    const pool = outfitCandidates(new Set([anchor.id]))
    return {
      kind,
      state: { anchor_outfit: outfitDecisionBlob(anchor, itemsById) },
      candidates: pool.map(c => ({ id: c.outfit.id, blob: c.blob })),
      question: 'Is this candidate outfit a close alternative to the anchor outfit (same occasion, vibe and weather)?',
      fingerprint: hash([outfitSignature(anchor), pool.map(c => outfitSignature(c.outfit)), itemsSig]),
      pick: scored => scored.slice(0, RELATED_OUTFIT_TOP),
    }
  }

  const collection = getCollection(targetId, userId)
  if (!collection) throw new RelatedNotFoundError()
  const members = getOutfitIdsInCollection(collection.id, userId)
  const pool = outfitCandidates(new Set(members))
  return {
    kind,
    state: {
      collection: {
        name: collection.name,
        ...(collection.description ? { description: collection.description } : {}),
        tags: safeList(collection.tags),
      },
    },
    candidates: pool.map(c => ({ id: c.outfit.id, blob: c.blob })),
    question: 'Does this candidate outfit belong in the collection?',
    fingerprint: hash([collection.id, collection.updatedAt, members, pool.map(c => outfitSignature(c.outfit)), itemsSig]),
    pick: scored => scored.filter(h => h.score >= RELATED_COLLECTION_THRESHOLD),
  }
}

// ─── Keyword fallback ──────────────────────────────────────────────────────────

/** Anchor fields that say what an item pairs with; its own category, brand and
 *  description describe the piece itself, not what goes with it. */
const ITEM_PAIRING_KEYS = new Set(['primaryColor', 'colors', 'season', 'occasion', 'tags', 'wearContext'])

function stringsIn(value: unknown, keep?: (key: string) => boolean): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(v => stringsIn(v))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => (keep && !keep(k) ? [] : stringsIn(v)))
  }
  return []
}

const wordSet = (texts: string[]) => new Set(searchTokens(texts.join(' ')).filter(t => t.length >= 3))

/**
 * Plain search-string scoring for when no decision provider is configured
 * (self-host without Jev). Same anchor and candidates as `relatedPlan`, so it
 * is user-scoped the same way; score = share of the anchor's words (colours,
 * season, occasion, tags, names) that also appear in the candidate. No model
 * call, no quota, nothing logged. Best first; ties keep the plan's recency order.
 */
export function keywordRelatedHits(plan: RelatedPlan): RelatedHit[] {
  const anchorBlob = Object.values(plan.state as Record<string, unknown>)[0]
  const anchorWords = wordSet(stringsIn(anchorBlob, plan.kind === 'item' ? k => ITEM_PAIRING_KEYS.has(k) : undefined))
  if (anchorWords.size === 0) return []
  const top = plan.kind === 'item' ? RELATED_ITEM_TOP : RELATED_OUTFIT_TOP
  return plan.candidates
    .map(c => {
      const words = wordSet(stringsIn(c.blob))
      let shared = 0
      for (const w of anchorWords) if (words.has(w)) shared++
      return { id: c.id, score: Math.round((shared / anchorWords.size) * 100) / 100 }
    })
    .filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top)
}

function safeList(json: string | null): string[] {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

/**
 * Scores every candidate and returns the picked hits, best first. Each batch
 * is one ai_calls row with run_id = requestId. Throws if any batch fails, so
 * the route can report an error that doesn't count toward the cap.
 */
export async function scoreRelated(
  plan: RelatedPlan,
  opts: { userId: string; requestId: string; identity?: Omit<AgentCallIdentity, 'runId'> },
): Promise<{ hits: RelatedHit[]; batchCount: number }> {
  const batches: Candidate[][] = []
  for (let i = 0; i < plan.candidates.length; i += RELATED_BATCH) batches.push(plan.candidates.slice(i, i + RELATED_BATCH))

  const scoredBatches = await Promise.all(batches.map(async batch => {
    // Keys are positional so candidate ids never become question names.
    const questions: DecisionsQuestions = {}
    batch.forEach((c, i) => {
      questions[`c${i}`] = { type: 'noul', instructions: `${plan.question} Candidate JSON: ${JSON.stringify(c.blob)}` }
    })
    const result = await runInstrumentedDecisions({
      userId: opts.userId,
      task: 'related',
      // runId stays the request id: finishRelated sums the find's cost by it.
      ...(opts.identity ?? {}),
      runId: opts.requestId,
      call: async () => generateDecisions(plan.state, questions),
    })
    return batch.flatMap((c, i) => {
      const answer = result.answers[`c${i}`]
      return answer && answer.type === 'noul' ? [{ id: c.id, score: answer.noul }] : []
    })
  }))

  const scored = scoredBatches.flat()
  // Stable: ties keep candidate order (most recent first).
  const order = new Map(plan.candidates.map((c, i) => [c.id, i]))
  scored.sort((a, b) => b.score - a.score || order.get(a.id)! - order.get(b.id)!)
  return { hits: plan.pick(scored), batchCount: batches.length }
}

// ─── One find, shared by the route and the agent tool ─────────────────────────

export type RelatedFindOutcome =
  | { status: 'unavailable' }
  | { status: 'busy' }
  | { status: 'capped'; quota: RelatedQuota }
  | { status: 'error'; quota: RelatedQuota }
  | { status: 'success' | 'empty'; hits: RelatedHit[]; foundAt: number; quota?: RelatedQuota; reused?: boolean }

/**
 * Runs one "Find related" for (kind, targetId), with the same decision-provider
 * gate, per-user claim, daily cap and request log as the detail-card button.
 * Throws RelatedNotFoundError for a missing or foreign target (before any claim
 * or model call). Jev is a free task: no wallet reservation, billedTokens = 0.
 *
 * `reuseFresh` returns the saved last result instead, when nothing it depends
 * on has changed (free, no quota, no model call). The route never sets it: a
 * tap on the button is an explicit "find again".
 */
export async function runRelatedFind(
  kind: RelatedKind,
  targetId: string,
  userId: string,
  opts: { reuseFresh?: boolean; identity?: Omit<AgentCallIdentity, 'runId'> } = {},
): Promise<RelatedFindOutcome> {
  if (!isDecisionsConfigured()) return { status: 'unavailable' }
  const plan = relatedPlan(kind, targetId, userId)

  if (opts.reuseFresh) {
    const last = lastRelated(userId, kind, targetId)
    if (last && last.fingerprint === plan.fingerprint) {
      return { status: last.status, hits: last.result, foundAt: last.createdAt, reused: true }
    }
  }

  const claim = claimRelated(userId, kind, targetId)
  if (claim.kind === 'busy') return { status: 'busy' }
  if (claim.kind === 'capped') return { status: 'capped', quota: claim.quota }

  const { requestId, quota } = claim
  const start = Date.now()
  if (plan.candidates.length === 0) {
    finishRelated(userId, requestId, { status: 'empty', candidateCount: 0, result: [], fingerprint: plan.fingerprint, batchCount: 0, latencyMs: 0 })
    return { status: 'empty', hits: [], foundAt: start, quota }
  }
  try {
    const { hits, batchCount } = await scoreRelated(plan, { userId, requestId, identity: opts.identity })
    const status = hits.length ? 'success' : 'empty'
    finishRelated(userId, requestId, {
      status, candidateCount: plan.candidates.length, result: hits,
      fingerprint: plan.fingerprint, batchCount, latencyMs: Date.now() - start,
    })
    return { status, hits, foundAt: start, quota }
  } catch (err) {
    // A failed find doesn't count toward the cap; its cost is still logged.
    finishRelated(userId, requestId, { status: 'error', candidateCount: plan.candidates.length, latencyMs: Date.now() - start })
    console.error('[related] find failed', { kind, error: err instanceof Error ? err.message : String(err) })
    return { status: 'error', quota: relatedQuota(userId) }
  }
}
