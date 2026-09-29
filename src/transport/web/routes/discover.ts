import { Router } from 'express'
import { imageUpload } from '../upload.js'
import { z } from 'zod'
import { listItems } from '../../../tools/items.js'
import { listOutfits } from '../../../tools/outfits.js'
import { getCurrentWeather } from '../../../tools/weather.js'
import { analyzeInspiration } from '../../../ai/inspiration.js'
import { matchClosetToContext, rankItemsForOccasionWithJev, rankItemsForInspirationWithJev, rankSavedOutfitsWithJev } from '../../../ai/discover.js'
import { getSharePayload } from '../../../tools/share.js'
import { topKHybrid, shouldUsePreFilter, getAllEmbeddings, topKTextWithScores, topKImageFromBuffer } from '../../../storage/embeddings.js'
import {
  PRE_FILTER_K, PRE_FILTER_K_PROMPT, SHORTLIST_POOL_K, OUTFIT_POOL_K,
  textItemShortlist, embeddingOutfitIds, itemSeededOutfitIds, fuseOutfitSignals,
} from '../../../ai/discoverRetrieval.js'
import { embedText, OUTFIT_TEXT_VARIANT } from '../../../ai/embed.js'
import { embedImage, embedItemImage } from '../../../ai/embedImage.js'
import { logDiscoverEvent } from '../../../ai/discoverEvents.js'
import { runInstrumented } from '../../../ai/instrumented.js'
import { VISION_MODEL } from '../../../ai/client.js'
import { freeTextModel } from '../../../ai/localModel.js'
import type { OutfitSuggestion, Item } from '../../../types/index.js'
import { tokenCost, type AiTask } from '../../../cost/tokenTable.js'
import { respondInsufficientTokens } from '../billingErrors.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'
import { InsufficientTokensError } from '../../../cost/errors.js'
import { isHostedMode } from '../../../hostedMode.js'
import { db } from '../../../db/client.js'
import { aiCalls } from '../../../db/schema.js'
import { eq, and, gte } from 'drizzle-orm'
import { startOfUtcDayMs } from '../../../time/utcDay.js'
import { shopQueryForPrompt, shopQueryForWeather, shopQueryForInspiration, shopQueryForShare, withWeather, type ShopQuery } from '../../../commerce/shopify/shopQuery.js'

const RETRIEVAL_MIN_OUTFITS = 10
// PRE_FILTER_K / PRE_FILTER_K_PROMPT / SHORTLIST_POOL_K / OUTFIT_POOL_K and the
// related-outfit cosine gate live in ai/discoverRetrieval.ts (shared with the
// agent's discover_closet tool).
const SUGGEST_RESHUFFLE_FREE_PER_DAY = 25
// Cosine gate: below this, short queries surface centroid-adjacent noise.
const RETRIEVAL_FAST_PATH_MIN_SIMILARITY = 0.50
// Jev-Noul gate for saved-outfit ranking under Related Outfits. Inspiration
// modes (prompt/image/shared) keep the gate so unrelated outfits stay out.
// Weather mode (Suggest) has no inspiration to be unrelated to: every saved
// outfit is a candidate and Jev orders them by occasion + weather fit. With the
// gate on, an occasion nothing clears (e.g. "date" on a work-heavy closet) fell
// through to the same occasion-blind recency list every time (#282).
const RELATED_MIN_JEV_SCORE = 0.55
const RELATED_MIN_JEV_SCORE_WEATHER = 0

/**
 * Image-mode inspiration → structured text for the downstream pipeline.
 * Canonical color names ("Primary colors: mustard, black") plus materials and
 * garments — the same vocabulary items are tagged with, so the text-embedding
 * pool and Jev can match them, and visually distinct uploads produce distinct
 * text downstream (issue #283).
 */
function buildImageContextText(inspiration: {
  description: string
  vibe: string
  dominantColors: string[]
  garmentHints?: string[]
  materials?: string[]
}): string {
  const colors = inspiration.dominantColors?.length
    ? `Primary colors: ${inspiration.dominantColors.join(', ')}. `
    : ''
  const materials = inspiration.materials?.length
    ? `Materials: ${inspiration.materials.join(', ')}. `
    : ''
  const garments = inspiration.garmentHints?.length
    ? `Garments: ${inspiration.garmentHints.join(', ')}.`
    : ''
  return `${inspiration.description} Vibe: ${inspiration.vibe}. ${colors}${materials}${garments}`
}

export function countTodaySuggestReshuffles(userId: string, now: number = Date.now()): number {
  return db.select({ id: aiCalls.id }).from(aiCalls)
    .where(and(
      eq(aiCalls.userId, userId),
      eq(aiCalls.task, 'suggest_reshuffle'),
      eq(aiCalls.success, 1),
      gte(aiCalls.createdAt, startOfUtcDayMs(now)),
    ))
    .all().length
}

interface DiscoverBilling {
  /** tokens charged on the matchClosetToContext (discover LLM) call */
  discoverCallTokens: number
  /** tokens charged on the analyzeInspiration call (image mode only) */
  inspirationTokens: number
  /** task label for the discover LLM call (weather mode reports as suggest) */
  discoverTask: AiTask
}

// Pricing per mode (decided in #205):
//  - shared: always free (auto-triggered, the user didn't request AI work)
//  - weather: this IS the Home "Suggest" action → priced as suggest, not
//    discover (1 first-gen; reshuffles free up to 25/day then 1)
//  - prompt/image: true Discover → 2 first-gen, 1 regenerate. Image charges on
//    the inspiration phase so the paired discover call stays free.
function resolveDiscoverBilling(userId: string, mode: string, isContinuation: boolean): DiscoverBilling {
  if (mode === 'shared') {
    return { discoverCallTokens: 0, inspirationTokens: 0, discoverTask: 'discover' }
  }
  if (mode === 'weather') {
    if (isContinuation) {
      const cost = countTodaySuggestReshuffles(userId) >= SUGGEST_RESHUFFLE_FREE_PER_DAY ? 1 : 0
      return { discoverCallTokens: cost, inspirationTokens: 0, discoverTask: 'suggest_reshuffle' }
    }
    return { discoverCallTokens: tokenCost('suggest'), inspirationTokens: 0, discoverTask: 'suggest' }
  }
  // prompt | image
  const cost = isContinuation ? 1 : tokenCost('discover')
  if (mode === 'image') {
    return { discoverCallTokens: 0, inspirationTokens: cost, discoverTask: 'discover' }
  }
  return { discoverCallTokens: cost, inspirationTokens: 0, discoverTask: 'discover' }
}

const flexBool = z.preprocess(v => v === true || v === 'true', z.boolean())

const router = Router()
const upload = imageUpload()

const discoverLimiter = perUserRateLimit(60_000, 10)

const DiscoverBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('prompt'),
    prompt: z.string().min(1).max(500),
    lat: z.number().optional(),
    lon: z.number().optional(),
    isRegenerate: flexBool.optional(),
  }),
  z.object({
    mode: z.literal('image'),
    lat: z.coerce.number().optional(),
    lon: z.coerce.number().optional(),
    isRegenerate: flexBool.optional(),
  }),
  z.object({
    mode: z.literal('shared'),
    shareId: z.string().min(1),
    lat: z.number().optional(),
    lon: z.number().optional(),
    isRegenerate: flexBool.optional(),
  }),
  z.object({
    mode: z.literal('weather'),
    lat: z.number(),
    lon: z.number(),
    occasion: z.string().max(40).optional(),
    isRegenerate: flexBool.optional(),
  }),
])

// POST /api/discover
router.post('/', discoverLimiter, upload.single('image'), async (req, res) => {
  const parsed = DiscoverBodySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const body = parsed.data
  const occasion = body.mode === 'weather' ? body.occasion : undefined
  const isProd = process.env.NODE_ENV === 'production'
  const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

  try {
    const userId = req.userId!
    const isContinuation = body.isRegenerate === true
    const billing = resolveDiscoverBilling(userId, body.mode, isContinuation)
    const items = await listItems({}, userId)
    if (items.length < 2) {
      return res.json({ context: { description: 'Not enough items', source: body.mode, retrievalMode: 'generated' }, suggestions: [] })
    }

    let weather = undefined
    if (body.lat !== undefined && body.lon !== undefined) {
      try {
        weather = await getCurrentWeather(body.lat, body.lon)
      } catch { /* weather is optional */ }
    }

    let contextText: string
    let contextDescription: string
    let imageBase64: string | undefined
    let itemsForGemini = items
    let sharedShortlistSource: 'hybrid' | 'full' = 'full'
    const preFilterEnabled = process.env.DISCOVER_PREFILTER_ENABLED === 'true'
      || process.env.DISCOVER_PREFILTER_ENABLED === '1'

    if (body.mode === 'prompt') {
      contextText = weather
        ? `${body.prompt} (Current weather: ${weather.temperature}°C, ${weather.condition})`
        : body.prompt
      contextDescription = body.prompt
    } else if (body.mode === 'weather') {
      if (!weather) throw new Error('Weather required for weather mode')
      const occasionPrefix = body.occasion ? `${body.occasion} outfit, ` : ''
      contextText = `${occasionPrefix}${weather.temperature}°C ${weather.condition} precip ${weather.precipitation}mm wind ${weather.windSpeed}km/h`
      contextDescription = `Today's weather: ${weather.condition}, ${weather.temperature}°C`
    } else if (body.mode === 'image') {
      if (!req.file) return res.status(400).json({ error: 'No image provided' })
      const b64 = req.file.buffer.toString('base64')
      const inspiration = await runInstrumented({
        userId,
        task: 'inspiration',
        model: VISION_MODEL,
        expectedBilledTokens: billing.inspirationTokens,
        call: async (_ctx) => {
          const { data, usage } = await analyzeInspiration(b64)
          return { result: data, usage }
        },
      })
      contextText = buildImageContextText(inspiration)
      contextDescription = `${inspiration.vibe} — ${inspiration.description}`
      imageBase64 = b64
    } else {
      // shared mode — hybrid pre-filter: text description + image snapshot via RRF
      const payload = getSharePayload(body.shareId)
      if (!payload) return res.status(404).json({ error: 'Share not found or expired' })
      if (payload.expiresAt && payload.expiresAt < Date.now()) {
        return res.status(404).json({ error: 'Share has expired' })
      }
      contextText = payload.description
      const sender = payload.senderHandle ? `Shared by ${payload.senderHandle}: ` : ''
      contextDescription = `${sender}${payload.description}`

      if (preFilterEnabled && shouldUsePreFilter(items.length)) {
        try {
          const imageUris: string[] = (() => {
            try { return JSON.parse(payload.imageUris ?? '[]') as string[] }
            catch { return [] }
          })()
          const firstImageUri = imageUris[0]

          const topIds = await topKHybrid(
            payload.description,
            embedText,
            firstImageUri,
            embedItemImage,
            userId,
          )
          if (topIds.length >= 12) {
            const topSet = new Set(topIds)
            itemsForGemini = items.filter(i => topSet.has(i.id))
            sharedShortlistSource = 'hybrid'
          }
        } catch { /* fall through to full */ }
      }
    }

    // ── Track A: Outfit retrieval fast path (weather-mode only) ────────────
    // Prompt/image mode has an explicit intent; short user text embeds too
    // weakly to gate LLM generation. Weather mode's query is implicit tags.
    const retrievalEnabled = process.env.DISCOVER_RETRIEVAL_ENABLED === 'true'
      || process.env.DISCOVER_RETRIEVAL_ENABLED === '1'

    if (retrievalEnabled && body.mode === 'weather') {
      try {
        const outfitEmbeds = getAllEmbeddings(userId, 'outfit', OUTFIT_TEXT_VARIANT)
        if (outfitEmbeds.size >= RETRIEVAL_MIN_OUTFITS) {
          const scored = await topKTextWithScores(contextText, embedText, userId, 'outfit', OUTFIT_TEXT_VARIANT, 5)
          const strong = scored.filter(s => s.score >= RETRIEVAL_FAST_PATH_MIN_SIMILARITY)
          if (strong.length >= 2) {
            const savedOutfits = await listOutfits({}, userId)
            const outfitMap = new Map(savedOutfits.map(o => [o.id, o]))
            const itemMap = new Map(items.map(i => [i.id, i]))

            const suggestions: OutfitSuggestion[] = strong
              .map(({ id }) => outfitMap.get(id))
              .filter((o): o is NonNullable<typeof o> => Boolean(o))
              .map(o => {
                const ids: string[] = JSON.parse(o.itemIds)
                return {
                  item_ids: ids,
                  name: o.name,
                  occasion: o.occasion ?? 'casual',
                  reasoning: 'Matched from your saved outfits',
                  items: ids.map(id => itemMap.get(id)).filter(Boolean) as typeof items,
                }
              })

            logDiscoverEvent({
              userId,
              mode: 'prompt', // weather-mode logs as 'prompt' per existing convention
              shortlistSource: 'outfit_retrieval',
              itemCount: items.length,
              shortlistedCount: strong.length,
              suggestionCount: suggestions.length,
              preFilterEnabled,
              occasion,
            })

            return res.json({
              context: { description: contextDescription, source: body.mode, retrievalMode: 'retrieved' },
              suggestions,
            })
          }
        }
      } catch { /* fall through to LLM generation */ }
    }

    // Free task: Gemini, or a local/ TEXT_MODEL (see freeTextModel).
    const discoverModel = freeTextModel()

    const raw = await runInstrumented({
      userId,
      task: billing.discoverTask,
      model: discoverModel,
      expectedBilledTokens: billing.discoverCallTokens,
      call: async (ctx) => {
        const { data, usage } = await matchClosetToContext(contextText, itemsForGemini, weather, userId, imageBase64, body.mode === 'weather' ? 'prompt' : body.mode, occasion)
        return { result: data, usage }
      },
    })

    // Hydrate item objects onto suggestions
    const itemMap = new Map(items.map(i => [i.id, i]))
    const suggestions: OutfitSuggestion[] = raw.map(s => ({
      ...s,
      items: s.item_ids.map(id => itemMap.get(id)).filter(Boolean) as typeof items,
    }))

    // Log shared-mode telemetry from the route (matchClosetToContext logs prompt/image)
    if (body.mode === 'shared') {
      logDiscoverEvent({
        userId,
        mode: 'shared',
        shortlistSource: sharedShortlistSource,
        itemCount: items.length,
        shortlistedCount: itemsForGemini.length,
        suggestionCount: suggestions.length,
        preFilterEnabled,
      })
    }

    res.json({
      context: { description: contextDescription, source: body.mode, retrievalMode: 'generated' },
      suggestions,
    })
  } catch (err) {
    if (respondInsufficientTokens(err, res)) return
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/discover/stream — SSE three-phase: shortlist → related_outfits → suggestions
router.post('/stream', discoverLimiter, upload.single('image'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const parsed = DiscoverBodySchema.safeParse(req.body)
  if (!parsed.success) { send('error', { error: 'Invalid body' }); res.end(); return }

  const body = parsed.data
  const occasion = body.mode === 'weather' ? body.occasion : undefined
  const excludeIdsRaw: { items?: string[]; outfits?: string[] } | undefined = (() => {
    const raw = req.body?.excludeIds
    if (!raw) return undefined
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) } catch { return undefined }
    }
    return raw as { items?: string[]; outfits?: string[] }
  })()
  const excludeItems = excludeIdsRaw?.items ?? []
  const excludeOutfitIds = excludeIdsRaw?.outfits ?? []

  const isProd = process.env.NODE_ENV === 'production'

  try {
    const userId = req.userId!
    const isContinuation = excludeItems.length > 0 || excludeOutfitIds.length > 0 || body.isRegenerate === true
    const billing = resolveDiscoverBilling(userId, body.mode, isContinuation)
    const items = await listItems({}, userId)
    if (items.length < 2) {
      send('error', { error: 'Not enough items' })
      res.end()
      return
    }

    let weather: Awaited<ReturnType<typeof getCurrentWeather>> | undefined = undefined
    if (body.mode === 'weather') {
      weather = await getCurrentWeather(body.lat, body.lon)
    } else if (body.lat !== undefined && body.lon !== undefined) {
      try {
        weather = await getCurrentWeather(body.lat, body.lon)
      } catch { /* weather is optional */ }
    }

    let contextText: string
    let contextDescription: string
    let imageBase64: string | undefined
    let shortlistedItems = items
    let shortlistSource: 'text' | 'image' | 'hybrid' | 'full' = 'full'
    // Related shop row query (#324) — garment words, never the display string.
    let shop: ShopQuery
    const preFilterEnabled = process.env.DISCOVER_PREFILTER_ENABLED === 'true'
      || process.env.DISCOVER_PREFILTER_ENABLED === '1'

    if (body.mode === 'prompt') {
      contextText = weather
        ? `${body.prompt} (Current weather: ${weather.temperature}°C, ${weather.condition})`
        : body.prompt
      contextDescription = body.prompt
      shop = withWeather(shopQueryForPrompt(body.prompt), weather)

      if (preFilterEnabled && shouldUsePreFilter(items.length)) {
        try {
          const filtered = await textItemShortlist(contextText, userId, PRE_FILTER_K_PROMPT, excludeItems)
          if (filtered.length >= PRE_FILTER_K) {
            const topSet = new Set(filtered)
            shortlistedItems = items.filter(i => topSet.has(i.id))
            shortlistSource = 'text'
          }
        } catch { /* fall through to full */ }
      }
    } else if (body.mode === 'weather') {
      // Spell the occasion out explicitly — "casual outfit, 15°C…" and "work
      // outfit, 15°C…" embed nearly identically (one token differs in ~15), so
      // the text prefilter can't separate occasions on its own. Doubling the
      // occasion marker gives the embedding a marginally stronger signal; the
      // real occasion discrimination comes from the Jev-Noul pool ranking below
      // (issue #282).
      const weatherBlob = `${weather!.temperature}°C ${weather!.condition} precip ${weather!.precipitation}mm wind ${weather!.windSpeed}km/h`
      const occasionPrefix = body.occasion
        ? `${body.occasion} outfit — occasion: ${body.occasion}. `
        : ''
      contextText = `${occasionPrefix}${weatherBlob}`
      contextDescription = `Today's weather: ${weather!.condition}, ${weather!.temperature}°C`
      shop = shopQueryForWeather(weather!, body.occasion)

      if (preFilterEnabled && shouldUsePreFilter(items.length)) {
        try {
          const filtered = await textItemShortlist(contextText, userId, PRE_FILTER_K, excludeItems)
          if (filtered.length >= PRE_FILTER_K) {
            const topSet = new Set(filtered)
            shortlistedItems = items.filter(i => topSet.has(i.id))
            shortlistSource = 'text'
          }
        } catch { /* fall through to full */ }
      }
    } else if (body.mode === 'image') {
      if (!req.file) { send('error', { error: 'No image provided' }); res.end(); return }
      const b64 = req.file.buffer.toString('base64')
      const inspiration = await runInstrumented({
        userId,
        task: 'inspiration',
        model: VISION_MODEL,
        expectedBilledTokens: billing.inspirationTokens,
        call: async (_ctx) => {
          const { data, usage } = await analyzeInspiration(b64)
          return { result: data, usage }
        },
      })
      contextText = buildImageContextText(inspiration)
      contextDescription = `${inspiration.vibe} — ${inspiration.description}`
      shop = withWeather(shopQueryForInspiration(inspiration), weather)
      imageBase64 = b64

      if (preFilterEnabled && shouldUsePreFilter(items.length)) {
        try {
          const topIds = await topKImageFromBuffer(
            req.file.buffer,
            embedImage,
            userId,
            PRE_FILTER_K + excludeItems.length,
          )
          const filtered = topIds.filter(id => !excludeItems.includes(id)).slice(0, PRE_FILTER_K)
          if (filtered.length >= PRE_FILTER_K) {
            const topSet = new Set(filtered)
            shortlistedItems = items.filter(i => topSet.has(i.id))
            shortlistSource = 'image'
            // Fallback to text if image pre-filter didn't work
            if (shortlistedItems.length < PRE_FILTER_K) {
              const textFiltered = await textItemShortlist(contextText, userId, PRE_FILTER_K, excludeItems)
              if (textFiltered.length >= PRE_FILTER_K) {
                const textSet = new Set(textFiltered)
                shortlistedItems = items.filter(i => textSet.has(i.id))
                shortlistSource = 'text'
              }
            }
          }
        } catch { /* fall through to full */ }
      }
    } else {
      // shared mode
      const payload = getSharePayload(body.shareId)
      if (!payload) { send('error', { error: 'Share not found or expired' }); res.end(); return }
      if (payload.expiresAt && payload.expiresAt < Date.now()) {
        send('error', { error: 'Share has expired' }); res.end(); return
      }
      contextText = payload.description
      const sender = payload.senderHandle ? `Shared by ${payload.senderHandle}: ` : ''
      contextDescription = `${sender}${payload.description}`
      shop = withWeather(shopQueryForShare(payload.description), weather)

      if (preFilterEnabled && shouldUsePreFilter(items.length)) {
        try {
          const imageUris: string[] = (() => {
            try { return JSON.parse(payload.imageUris ?? '[]') as string[] }
            catch { return [] }
          })()
          const firstImageUri = imageUris[0]

          const topIds = await topKHybrid(
            payload.description,
            embedText,
            firstImageUri,
            embedItemImage,
            userId,
          )
          if (topIds.length >= PRE_FILTER_K) {
            const topSet = new Set(topIds)
            shortlistedItems = items.filter(i => topSet.has(i.id))
            shortlistSource = 'hybrid'
          }
        } catch { /* fall through to full */ }
      }
    }

    // ── Compute pool (larger than shortlist for clientside reshuffling) ─────
    // Closets below the prefilter threshold (24) never get here with a truncated
    // shortlist — they already pool the whole wardrobe (issue #282).
    let itemPool = shortlistedItems.filter(i => !excludeItems.includes(i.id))
    if (preFilterEnabled && itemPool.length < SHORTLIST_POOL_K) {
      try {
        const poolFiltered = await textItemShortlist(contextText, userId, SHORTLIST_POOL_K, excludeItems)
        if (poolFiltered.length > itemPool.length) {
          const poolSet = new Set(poolFiltered)
          itemPool = items.filter(i => poolSet.has(i.id))
        }
      } catch { /* keep shortlist as pool */ }
    }

    // ── Jev-Noul pool ranking (every mode) ──────────────────────────────────
    // This is what actually differentiates one request from the next: the pool
    // above is embedding-sorted at best (near-identical across occasions,
    // #282) and, with the prefilter off or no item vectors, just the whole
    // closet newest-first — identical for every prompt (#330). Jev ranks the
    // pool (one batched Noul per item): by occasion + weather fit in weather
    // mode, by inspiration fit otherwise. The client reshuffle then walks that
    // order. Embedding order is kept on any failure — Jev is an enhancement,
    // not a dependency.
    let poolJevOrdered = false
    if (itemPool.length > 1) {
      try {
        // Cap the batch at the pool K — an unbounded closet with the prefilter
        // off would otherwise ship hundreds of Nouls in one request.
        const rankingInput = itemPool.slice(0, SHORTLIST_POOL_K)
        const rankOpts = {
          userId,
          contextText,
          items: rankingInput,
          weather: weather ?? undefined,
          occasion,
        }
        const ranked = body.mode === 'weather'
          ? await rankItemsForOccasionWithJev(rankOpts)
          : await rankItemsForInspirationWithJev(rankOpts)
        if (ranked.length === rankingInput.length) {
          itemPool = [...ranked, ...itemPool.slice(SHORTLIST_POOL_K)]
          poolJevOrdered = true
        }
      } catch (err) {
        console.warn('[discover] Jev pool ranking failed — keeping embedding order:', (err as Error).message ?? String(err))
      }
    }

    // The shortlist event keeps its members but adopts the pool order so the
    // "Based on these items" strip leads with the occasion-fitting pieces.
    // The ranked members are also handed to compose, so matchClosetToContext
    // skips its own Noul batch (one Jev call per request).
    let preRankedShortlist: Item[] | undefined
    if (poolJevOrdered) {
      const poolOrder = new Map(itemPool.map((it, idx) => [it.id, idx]))
      shortlistedItems = [...shortlistedItems].sort(
        (a, b) =>
          (poolOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (poolOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )
      preRankedShortlist = shortlistedItems.filter(i => {
        const idx = poolOrder.get(i.id)
        return idx !== undefined && idx < SHORTLIST_POOL_K
      })
    }

    // Phase 1: emit shortlist immediately
    send('shortlist', {
      items: shortlistedItems,
      pool: itemPool,
      source: shortlistSource,
      contextDescription,
      shop,
    })

    // Phase 2+3: run related outfits + LLM in parallel
    // ── Helper: find related outfits via layered signals ──────────────────
    type HydratedOutfitRecord = Record<string, unknown> & { items: Item[] }
    async function findRelatedOutfits(): Promise<{
      outfits: HydratedOutfitRecord[]
      pool: HydratedOutfitRecord[]
      source: 'jev' | 'embedding' | 'item-seeded' | 'fused' | 'recent' | 'none' | 'error'
    }> {
      try {
        const savedOutfits = await listOutfits({}, userId)
        if (savedOutfits.length === 0) {
          return { outfits: [], pool: [], source: 'none' }
        }

        const outfitMap = new Map(savedOutfits.map(o => [o.id, o]))
        const itemMap = new Map(items.map(i => [i.id, i]))

        function hydrate(o: typeof savedOutfits[number]): HydratedOutfitRecord {
          const ids: string[] = JSON.parse(o.itemIds)
          return { ...o, items: ids.map(id => itemMap.get(id)).filter(Boolean) as Item[] }
        }

        const exOut = new Set(excludeOutfitIds)

        // ── Signal 1: Jev-Noul on saved outfits (falls back to embedding) ─
        // Jev reads outfit + item metadata (color, category, tags) so short
        // queries like "all yellow" match the yellow saved outfits even when
        // their text embedding is weakly aligned with the query embedding.
        let signal1Ids: string[] = []
        let signal1Source: 'jev' | 'embedding' = 'jev'
        try {
          const eligible = savedOutfits.filter(o => !exOut.has(o.id))
          const minJevScore = body.mode === 'weather' ? RELATED_MIN_JEV_SCORE_WEATHER : RELATED_MIN_JEV_SCORE
          signal1Ids = (await rankSavedOutfitsWithJev(
            contextText, eligible, itemMap, userId,
            weather ?? undefined, occasion, minJevScore,
          )).slice(0, OUTFIT_POOL_K)
        } catch {
          signal1Source = 'embedding'
          signal1Ids = await embeddingOutfitIds(contextText, userId, excludeOutfitIds, OUTFIT_POOL_K)
        }

        // ── Signal 2: item-seeded — outfits intersecting the top items ─────
        // When Jev ordered the pool, seed from its top items. The embedding
        // shortlist's members barely move between occasions, so seeding from
        // it put the same outfits near the top of every Suggest (#282).
        // Never seed from the unfiltered closet: every outfit then "matches"
        // and the ranking is just item count — the same list for every prompt,
        // which RRF let outvote Jev (#330).
        const seedItems = poolJevOrdered
          ? itemPool.slice(0, PRE_FILTER_K)
          : shortlistSource === 'full' ? [] : shortlistedItems
        // Score = mean reciprocal rank of the outfit's items in the seed order
        // (see itemSeededOutfitIds, #330).
        const signal2Ids = itemSeededOutfitIds(savedOutfits, seedItems.map(i => i.id), exOut, OUTFIT_POOL_K)

        // ── Fuse signals 1+2 via RRF, pad with recency ────────────────────
        const fusedIds = fuseOutfitSignals(signal1Ids, signal2Ids, savedOutfits, exOut, OUTFIT_POOL_K)

        let source: 'embedding' | 'item-seeded' | 'fused' | 'recent' | 'none' | 'jev' = 'none'
        if (signal1Ids.length > 0 && signal2Ids.length > 0) source = 'fused'
        else if (signal1Ids.length > 0) source = signal1Source === 'jev' ? 'jev' : 'embedding'
        else if (signal2Ids.length > 0) source = 'item-seeded'

        if (fusedIds.length === 0) {
          return { outfits: [], pool: [], source: 'none' }
        }

        const hydratedOutfits = fusedIds
          .map(id => outfitMap.get(id))
          .filter((o): o is NonNullable<typeof o> => Boolean(o))
          .map(hydrate)

        return { outfits: hydratedOutfits, pool: hydratedOutfits, source }
      } catch {
        return { outfits: [], pool: [], source: 'error' }
      }
    }

    // ── Start both phases in parallel ─────────────────────────────────────
    const relatedPromise = findRelatedOutfits()
    // Free task: Gemini, or a local/ TEXT_MODEL (see freeTextModel).
    const discoverModel = freeTextModel()

    const llmPromise = (async () => {
      const raw = await runInstrumented({
        userId,
        task: billing.discoverTask,
        model: discoverModel,
        expectedBilledTokens: billing.discoverCallTokens,
        call: async (_ctx) => {
          const { data, usage } = await matchClosetToContext(contextText, shortlistedItems, weather ?? undefined, userId, imageBase64, body.mode === 'weather' ? 'prompt' : body.mode, occasion, preRankedShortlist)
          return { result: data, usage }
        },
      })
      const imap = new Map(items.map(i => [i.id, i]))
      return raw.map(s => ({
        ...s,
        items: s.item_ids.map(id => imap.get(id)).filter(Boolean) as Item[],
      }))
    })()
    // llmPromise is only awaited after related outfits resolve. If it rejects
    // first (e.g. InsufficientTokensError from the wallet reservation, which
    // fires before any model call) it has no handler yet, and Node's unhandled-
    // rejection default kills the whole server. Mark it handled here; the
    // `await llmPromise` below still throws into this route's catch.
    llmPromise.catch(() => {})

    // Phase 2: emit related outfits (usually finishes first)
    const relatedResult = await relatedPromise
    send('related_outfits', relatedResult)

    // Shared-mode telemetry (doesn't affect stream, just logging)
    if (body.mode === 'shared') {
      logDiscoverEvent({
        userId,
        mode: 'shared',
        shortlistSource: shortlistSource === 'hybrid' ? 'hybrid' : 'full',
        itemCount: items.length,
        shortlistedCount: shortlistedItems.length,
        suggestionCount: 0,
        preFilterEnabled,
      })
    }

    // Phase 3: emit AI suggestions (LLM finishes last)
    const suggestions = await llmPromise
    send('suggestions', { suggestions, retrievalMode: 'generated' })
    send('done', {})
    res.end()
  } catch (err) {
    // #315 — self-host has no token paywall, so InsufficientTokensError can't
    // fire there; gate the branch so the SSE error stays generic when hosted
    // mode is off.
    if (isHostedMode() && err instanceof InsufficientTokensError) {
      send('error', { error: 'Insufficient tokens', code: 'INSUFFICIENT_TOKENS', required: err.required, balance: err.balance })
      res.end()
      return
    }
    // Prod hides the message from the client, so log it (a weather 429 here was invisible).
    console.error('[discover/stream] failed:', err instanceof Error ? err.message : String(err))
    const msg = isProd ? 'Internal server error' : String(err)
    send('error', { error: msg })
    res.end()
  }
})

export default router
