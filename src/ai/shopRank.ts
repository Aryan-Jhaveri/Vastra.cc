import { generateDecisions, type DecisionsQuestions } from './decisions.js'
import { runInstrumentedDecisions } from './instrumented.js'
import { itemDecisionBlob, outfitDecisionBlob } from './decisionText.js'
import type { Item, Outfit } from '../types/index.js'
import type { ShopProduct, ProductDecisionDetails } from '../commerce/shopify/catalog.js'

/**
 * Rank the Related shop row (#324) by how closely each product matches what
 * the user is already looking at: the related closet items, related outfits
 * and the AI outfit recommendations from the same Suggest/Discover run.
 *
 * One batched Jev-Noul call — one question per product — sorted by descending
 * Noul. Same shape as Discover's item ranking (src/ai/discover.ts). Free task:
 * master key only, no wallet, recorded in ai_calls as `shop_rank`.
 *
 * State carries closet item/outfit text (as Discover already sends) and the
 * shop query. No ids, no `user_*` keys (decisions.ts rejects them). Product
 * text is merchant-written and untrusted; it only ever sits inside a question,
 * and Jev only returns a probability.
 */

export const SHOP_RANK_MAX_ITEMS = 8
export const SHOP_RANK_MAX_OUTFITS = 4
export const SHOP_RANK_MAX_RECOMMENDATIONS = 3
const REASONING_MAX_CHARS = 200

export interface ShopRecommendation {
  name: string
  occasion?: string
  reasoning?: string
  items: Item[]
}

export interface ShopRankContext {
  query: string
  intent?: string
  items: Item[]
  outfits: Outfit[]
  /** Items referenced by `outfits`, for outfitDecisionBlob. */
  outfitItemsById: Map<string, Item>
  recommendations: ShopRecommendation[]
}

function cap(text: string | undefined, max: number): string | undefined {
  const t = text?.trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** True when there is closet context to rank against (else ranking is noise). */
export function hasShopRankContext(ctx: Pick<ShopRankContext, 'items' | 'outfits' | 'recommendations'>): boolean {
  return ctx.items.length > 0 || ctx.outfits.length > 0 || ctx.recommendations.length > 0
}

export function buildShopRankState(ctx: ShopRankContext): Record<string, unknown> {
  const state: Record<string, unknown> = { shop_query: ctx.query }
  if (ctx.intent) state.intent = ctx.intent
  const items = ctx.items.slice(0, SHOP_RANK_MAX_ITEMS).map(itemDecisionBlob)
  if (items.length) state.related_closet_items = items
  const outfits = ctx.outfits.slice(0, SHOP_RANK_MAX_OUTFITS)
    .map(o => outfitDecisionBlob(o, ctx.outfitItemsById))
    .filter(o => o.items.length > 0)
  if (outfits.length) state.related_outfits = outfits
  const recs = ctx.recommendations.slice(0, SHOP_RANK_MAX_RECOMMENDATIONS).map(r => {
    const rec: Record<string, unknown> = { name: cap(r.name, 120) ?? 'Outfit' }
    const occasion = cap(r.occasion, 40)
    const reasoning = cap(r.reasoning, REASONING_MAX_CHARS)
    if (occasion) rec.occasion = occasion
    if (reasoning) rec.reasoning = reasoning
    rec.items = r.items.map(itemDecisionBlob)
    return rec
  })
  if (recs.length) state.outfit_recommendations = recs
  return state
}

/**
 * Returns `products` reordered by match, highest first. Products Jev didn't
 * answer for keep their catalog order after the scored ones. Throws on a Jev
 * error so the route can fall back to catalog order.
 */
export async function rankShopProductsWithJev(opts: {
  userId: string
  context: ShopRankContext
  products: ShopProduct[]
  details: Record<string, ProductDecisionDetails>
  /** Links the decision's ai_calls row to a request (e.g. a related_requests id). */
  runId?: string
}): Promise<ShopProduct[]> {
  const { userId, context, products, details, runId } = opts
  if (products.length === 0) return []

  // Keys are positional: product ids are GIDs with slashes and colons.
  const questions: DecisionsQuestions = {}
  products.forEach((p, i) => {
    const product = details[p.id] ?? { title: p.title }
    questions[`p${i}`] = {
      type: 'noul',
      instructions:
        'How closely does this shop product match the look in the state — the related closet items, ' +
        `related outfits and outfit recommendations? Product JSON: ${JSON.stringify(product)}`,
    }
  })

  const result = await runInstrumentedDecisions({
    userId,
    runId,
    task: 'shop_rank',
    call: async () => generateDecisions(buildShopRankState(context), questions),
  })

  const scored: Array<{ product: ShopProduct; score: number; index: number }> = []
  const unscored: ShopProduct[] = []
  products.forEach((product, index) => {
    const ans = result.answers[`p${index}`]
    if (ans && ans.type === 'noul') scored.push({ product, score: ans.noul, index })
    else unscored.push(product)
  })
  // Stable: ties keep catalog order.
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return [...scored.map(s => s.product), ...unscored]
}
