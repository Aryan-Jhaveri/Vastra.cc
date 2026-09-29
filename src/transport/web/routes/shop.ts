import { Router } from 'express'
import { nanoid } from 'nanoid'
import { db } from '../../../db/client.js'
import { likedProducts } from '../../../db/schema.js'
import { eq, desc, inArray, and, count } from 'drizzle-orm'
import { requireUserId, getItem, getOutfit } from '../../../db/queries.js'
import { userCountry, userShopGender } from '../../../commerce/shopify/userPrefs.js'
import {
  searchGlobalCatalog,
  lookupGlobalCatalog,
  LOOKUP_MAX_IDS,
  type ShopProduct,
} from '../../../commerce/shopify/catalog.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'
import {
  rankShopProductsWithJev,
  hasShopRankContext,
  SHOP_RANK_MAX_ITEMS,
  SHOP_RANK_MAX_OUTFITS,
  SHOP_RANK_MAX_RECOMMENDATIONS,
  type ShopRankContext,
  type ShopRecommendation,
} from '../../../ai/shopRank.js'
import type { Item, Outfit } from '../../../types/index.js'
import { itemShopQuery } from '../../../commerce/itemShopQuery.js'
import { claimRelated, finishRelated } from '../../../db/relatedRequests.js'

// Shopify catalog policy (https://shopify.dev/docs/agents/catalog): results
// must not be cached and images must not be downloaded to servers. So:
// every search is a live call, liked items store only product ids and are
// re-read live, and there is no server-side image fetch.

const router = Router()

const shopLimiter = perUserRateLimit(60_000, 10)
const likesReadLimiter = perUserRateLimit(60_000, 30)

const MAX_PRODUCT_ID = 256
const MAX_LIKES_PER_USER = 500
const PRODUCT_GID_PREFIX = 'gid://shopify/p/'
const MAX_QUERY = 500
const MAX_INTENT = 500
/** Unranked: one catalog page as before. Ranked: a bigger pool, best first. */
const UNRANKED_LIMIT = 10
const RANKED_POOL = 24
const MAX_ID = 64
const MAX_REC_TEXT = 500
const MAX_REC_ITEMS = 8

// ─── POST /api/shop/related ────────────────────────────────────────────────────
// Body: { query, intent?, cursor?, context? } — the shop query built server-side
// by commerce/shopify/shopQuery.ts and delivered in the Discover shortlist event.
// With `context` ({ itemIds, outfitIds, recommendations }) the route pulls a
// 24-product pool and returns it ranked by Jev, best match first (`ranked`).

interface RawShopContext {
  itemIds?: unknown
  outfitIds?: unknown
  recommendations?: unknown
}

function idList(raw: unknown, max: number): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.length > max) return null
  if (!raw.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID)) return null
  return [...new Set(raw as string[])]
}

function optText(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || raw.length > MAX_REC_TEXT) return null
  return raw
}

/** Items the user owns, in request order; unknown and foreign ids are skipped. */
function ownItems(ids: string[], userId: string): Item[] {
  return ids.map(id => getItem(id, userId)).filter((i): i is Item => Boolean(i))
}

function outfitItemIds(outfit: Outfit): string[] {
  try {
    const ids = JSON.parse(outfit.itemIds)
    return Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []
  } catch {
    return []
  }
}

/**
 * Parse the optional ranking context. Everything is re-read server-side and
 * scoped to the session user — the client sends ids, never closet data, and
 * a foreign or unknown id is silently dropped (no existence oracle). Returns
 * null for a malformed body (→ 400).
 */
function parseRankContext(raw: unknown, userId: string, query: string, intent: string | undefined): ShopRankContext | null {
  const empty: ShopRankContext = { query, intent, items: [], outfits: [], outfitItemsById: new Map(), recommendations: [] }
  if (raw === undefined || raw === null) return empty
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const ctx = raw as RawShopContext

  const itemIds = idList(ctx.itemIds, SHOP_RANK_MAX_ITEMS * 3)
  const outfitIds = idList(ctx.outfitIds, SHOP_RANK_MAX_OUTFITS * 3)
  if (!itemIds || !outfitIds) return null

  const recsRaw = ctx.recommendations ?? []
  if (!Array.isArray(recsRaw) || recsRaw.length > SHOP_RANK_MAX_RECOMMENDATIONS * 2) return null
  const recommendations: ShopRecommendation[] = []
  for (const r of recsRaw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null
    const rec = r as Record<string, unknown>
    const name = optText(rec.name)
    const occasion = optText(rec.occasion)
    const reasoning = optText(rec.reasoning)
    const recItemIds = idList(rec.itemIds, MAX_REC_ITEMS)
    if (name === null || occasion === null || reasoning === null || !recItemIds) return null
    const items = ownItems(recItemIds, userId)
    if (items.length === 0 && !reasoning) continue
    recommendations.push({ name: name ?? 'Outfit', occasion, reasoning, items })
  }

  const outfits = outfitIds.slice(0, SHOP_RANK_MAX_OUTFITS)
    .map(id => getOutfit(id, userId))
    .filter((o): o is Outfit => Boolean(o))
  const outfitItemsById = new Map<string, Item>()
  for (const item of ownItems([...new Set(outfits.flatMap(outfitItemIds))], userId)) {
    outfitItemsById.set(item.id, item)
  }

  return {
    query,
    intent,
    items: ownItems(itemIds.slice(0, SHOP_RANK_MAX_ITEMS), userId),
    outfits,
    outfitItemsById,
    recommendations: recommendations.slice(0, SHOP_RANK_MAX_RECOMMENDATIONS),
  }
}

router.post('/related', shopLimiter, async (req, res) => {
  const userId = req.userId!
  requireUserId(userId)

  const { query, intent, cursor, context } = req.body as { query?: unknown; intent?: unknown; cursor?: unknown; context?: unknown }
  if (typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'query is required' })
  }
  if (query.length > MAX_QUERY) {
    return res.status(400).json({ error: `query too long (max ${MAX_QUERY} chars)` })
  }
  if (intent !== undefined && intent !== null && (typeof intent !== 'string' || intent.length > MAX_INTENT)) {
    return res.status(400).json({ error: 'invalid intent' })
  }
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024)) {
    return res.status(400).json({ error: 'invalid cursor' })
  }
  const cleanQuery = query.trim()
  const cleanIntent = typeof intent === 'string' && intent.trim() ? intent.trim() : undefined
  const rankContext = parseRankContext(context, userId, cleanQuery, cleanIntent)
  if (!rankContext) return res.status(400).json({ error: 'invalid context' })
  const rank = hasShopRankContext(rankContext)

  let result
  try {
    result = await searchGlobalCatalog({
      query: cleanQuery,
      intent: cleanIntent,
      country: userCountry(userId),
      gender: userShopGender(userId),
      limit: rank ? RANKED_POOL : UNRANKED_LIMIT,
      cursor: typeof cursor === 'string' && cursor ? cursor : undefined,
    })
  } catch (err) {
    // A catalog error or timeout → [] plus a logged warning, never a 500.
    console.warn('[shop/related] catalog error:', String((err as Error).message ?? err))
    return res.json({ products: [], nextCursor: null, ranked: false, error: 'catalog_unavailable' })
  }

  if (!rank || result.products.length < 2) {
    return res.json({ products: result.products, nextCursor: result.nextCursor, ranked: false })
  }
  try {
    const products = await rankShopProductsWithJev({
      userId,
      context: rankContext,
      products: result.products,
      details: result.details ?? {},
    })
    res.json({ products, nextCursor: result.nextCursor, ranked: true })
  } catch (err) {
    // Jev down / no master key → catalog order. The row still shows.
    console.warn('[shop/related] jev rank failed, using catalog order:', String((err as Error).message ?? err))
    res.json({ products: result.products, nextCursor: result.nextCursor, ranked: false })
  }
})

// ─── Related shop items for one closet item (#332) ─────────────────────────────
// POST /api/shop/for-item/:id  { cursor? }
// The query is built server-side from the item (itemShopQuery: no ids, image,
// brand or size go out). The first page is one "find" against the same daily
// cap as Find related (related_requests kind 'item_shop'); More pages pass
// the cursor and don't count again.
router.post('/for-item/:id', shopLimiter, async (req, res) => {
  const userId = req.userId!
  requireUserId(userId)
  const item = getItem(String(req.params.id), userId)
  if (!item) return res.status(404).json({ error: 'Not found' })
  const { cursor } = req.body as { cursor?: unknown }
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024)) {
    return res.status(400).json({ error: 'invalid cursor' })
  }
  const paging = typeof cursor === 'string' && cursor.length > 0
  const query = itemShopQuery(item)

  let requestId: string | undefined
  if (!paging) {
    const claim = claimRelated(userId, 'item_shop', item.id)
    if (claim.kind === 'busy') return res.status(409).json({ error: 'related_in_progress' })
    if (claim.kind === 'capped') return res.status(429).json({ error: 'related_daily_limit', resetsAt: claim.quota.resetsAt })
    requestId = claim.requestId
  }
  const start = Date.now()
  const finish = (status: 'success' | 'empty' | 'error', count?: number) => {
    if (requestId) finishRelated(userId, requestId, { status, candidateCount: count, latencyMs: Date.now() - start })
  }

  let result
  try {
    result = await searchGlobalCatalog({
      query,
      country: userCountry(userId),
      gender: userShopGender(userId),
      limit: RANKED_POOL,
      cursor: paging ? cursor as string : undefined,
    })
  } catch (err) {
    console.warn('[shop/for-item] catalog error:', String((err as Error).message ?? err))
    finish('error')
    return res.status(502).json({ error: 'catalog_unavailable' })
  }

  const rankContext = parseRankContext({ itemIds: [item.id], outfitIds: [], recommendations: [] }, userId, query, undefined)
  let products = result.products
  let ranked = false
  if (rankContext && products.length > 1) {
    try {
      products = await rankShopProductsWithJev({ userId, context: rankContext, products, details: result.details ?? {}, runId: requestId })
      ranked = true
    } catch (err) {
      console.warn('[shop/for-item] rank failed, using catalog order:', String((err as Error).message ?? err))
    }
  }
  finish(products.length ? 'success' : 'empty', products.length)
  res.json({ products, nextCursor: result.nextCursor, ranked, query })
})

// ─── Likes ─────────────────────────────────────────────────────────────────────

function validProductId(productId: unknown): productId is string {
  return typeof productId === 'string'
    && productId.startsWith(PRODUCT_GID_PREFIX)
    && productId.length > PRODUCT_GID_PREFIX.length
    && productId.length <= MAX_PRODUCT_ID
}

/**
 * `live` — current catalog data; `gone` — Shopify reports the product
 * not found (delisted); `unknown` — the lookup failed, so we can't tell.
 */
type LikeStatus = 'live' | 'gone' | 'unknown'

interface HydratedLike {
  productId: string
  savedItemId: string | null
  createdAt: number
  status: LikeStatus
  product: ShopProduct | null
}

// GET /api/shop/likes?offset=0&limit=24 — one page of likes (newest first),
// each hydrated with live catalog data in a single lookup_catalog call.
router.get('/likes', likesReadLimiter, async (req, res) => {
  const userId = req.userId!
  requireUserId(userId)

  const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0)
  const limitRaw = Number.parseInt(String(req.query.limit ?? '24'), 10) || 24
  const limit = Math.min(Math.max(1, limitRaw), LOOKUP_MAX_IDS)

  try {
    const [{ total }] = db.select({ total: count() }).from(likedProducts)
      .where(eq(likedProducts.userId, userId))
      .all()
    const rows = db.select().from(likedProducts)
      .where(eq(likedProducts.userId, userId))
      .orderBy(desc(likedProducts.createdAt), desc(likedProducts.id))
      .limit(limit)
      .offset(offset)
      .all()

    const nextOffset = offset + rows.length < total ? offset + rows.length : null
    if (rows.length === 0) return res.json({ likes: [], total, nextOffset: null })

    let byId = new Map<string, ShopProduct>()
    let notFound = new Set<string>()
    let catalogError = false
    try {
      const result = await lookupGlobalCatalog({ ids: rows.map(r => r.productId), country: userCountry(userId) })
      byId = new Map(result.products.map(p => [p.id, p]))
      notFound = new Set(result.notFound)
    } catch (err) {
      catalogError = true
      console.warn('[shop/likes] catalog lookup error:', String((err as Error).message ?? err))
    }

    const likes: HydratedLike[] = rows.map(r => {
      const product = byId.get(r.productId) ?? null
      const status: LikeStatus = product ? 'live' : (!catalogError && notFound.has(r.productId)) ? 'gone' : 'unknown'
      return { productId: r.productId, savedItemId: r.savedItemId, createdAt: r.createdAt, status, product }
    })

    res.json({ likes, total, nextOffset, ...(catalogError ? { error: 'catalog_unavailable' } : {}) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/shop/likes/ids — every liked product id, for heart state in the
// shop row. Ids only: no catalog call.
router.get('/likes/ids', async (req, res) => {
  try {
    const userId = req.userId!
    requireUserId(userId)
    const rows = db.select({ productId: likedProducts.productId }).from(likedProducts)
      .where(eq(likedProducts.userId, userId))
      .all()
    res.json({ productIds: rows.map(r => r.productId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/shop/likes/:productId — like a product. Only the id is stored.
router.put('/likes/:productId', async (req, res) => {
  try {
    const userId = req.userId!
    requireUserId(userId)
    const { productId } = req.params
    if (!validProductId(productId)) return res.status(400).json({ error: 'invalid productId' })

    const existing = db.select({ id: likedProducts.id }).from(likedProducts)
      .where(and(eq(likedProducts.userId, userId), eq(likedProducts.productId, productId)))
      .get()
    if (existing) return res.json({ ok: true })

    const [{ n }] = db.select({ n: count() }).from(likedProducts)
      .where(eq(likedProducts.userId, userId))
      .all()
    if (n >= MAX_LIKES_PER_USER) {
      return res.status(409).json({ error: 'like_limit_reached', limit: MAX_LIKES_PER_USER })
    }

    db.insert(likedProducts).values({
      id: nanoid(),
      userId,
      productId,
      savedItemId: null,
      createdAt: Date.now(),
    })
      .onConflictDoNothing({ target: [likedProducts.userId, likedProducts.productId] })
      .run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/shop/likes/:productId — unlike a product
router.delete('/likes/:productId', async (req, res) => {
  try {
    const userId = req.userId!
    requireUserId(userId)
    const { productId } = req.params
    db.delete(likedProducts)
      .where(and(eq(likedProducts.userId, userId), eq(likedProducts.productId, productId)))
      .run()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/shop/likes/bulk-delete — unlike multiple products
router.post('/likes/bulk-delete', async (req, res) => {
  try {
    const userId = req.userId!
    requireUserId(userId)
    const { productIds } = req.body as { productIds?: unknown }
    if (!Array.isArray(productIds) || productIds.length > MAX_LIKES_PER_USER
      || !productIds.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: 'productIds must be an array of strings' })
    }
    if (productIds.length === 0) return res.json({ ok: true })

    // Only delete likes belonging to the caller. Foreign or unknown ids are
    // ignored, never an error that reveals whether they exist.
    db.delete(likedProducts)
      .where(and(
        eq(likedProducts.userId, userId),
        inArray(likedProducts.productId, productIds as string[]),
      ))
      .run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/shop/likes/:productId/saved-item — link a like to a closet item
router.patch('/likes/:productId/saved-item', async (req, res) => {
  try {
    const userId = req.userId!
    requireUserId(userId)
    const { productId } = req.params
    const { savedItemId } = req.body as { savedItemId?: unknown }
    if (savedItemId !== null && (typeof savedItemId !== 'string' || savedItemId.length === 0)) {
      return res.status(400).json({ error: 'savedItemId must be a string or null' })
    }

    const existing = db.select().from(likedProducts)
      .where(and(eq(likedProducts.userId, userId), eq(likedProducts.productId, productId)))
      .get()
    if (!existing) return res.status(404).json({ error: 'not found' })

    // The item must be the caller's own. A foreign or unknown id gets the same
    // 404, so the response never reveals whether another user's item exists.
    if (savedItemId !== null && !getItem(savedItemId, userId)) {
      return res.status(404).json({ error: 'item not found' })
    }

    db.update(likedProducts)
      .set({ savedItemId })
      .where(and(eq(likedProducts.userId, userId), eq(likedProducts.productId, productId)))
      .run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
