import { generateJSONWithUsage, type UsageMetadata } from './client.js'
import { freeTextModel } from './localModel.js'
import { generateDecisions, type DecisionsQuestions } from './decisions.js'
import { runInstrumentedDecisions } from './instrumented.js'
import type { Item, Outfit, OutfitSuggestion, WeatherData } from '../types/index.js'
import { topKText, topKImageFromBuffer, shouldUsePreFilter } from '../storage/embeddings.js'
import { embedText } from './embed.js'
import { embedImage } from './embedImage.js'
import { logDiscoverEvent } from './discoverEvents.js'
import { itemDecisionBlob, outfitDecisionBlob } from './decisionText.js'

const PRE_FILTER_K = 12
// How many Jev-ranked items to hand Gemini for the compose step. Jev narrows
// the shortlist to this subset; Gemini then composes 2 outfits from it with
// names + prose reasoning. Tune later.
const JEV_COMPOSE_TOP_N = 8

export async function matchClosetToContext(
  contextText: string,
  items: Item[],
  weather?: WeatherData,
  userId = 'self',
  imageBase64?: string,
  discoverMode: 'prompt' | 'image' | 'shared' = 'prompt',
  occasion?: string,
  // Items the caller already Jev-ranked (weather-mode occasion-fit pool, #282).
  // Skips the prefilter + second Noul batch — one Jev call per request, not two.
  preRankedItems?: Item[],
): Promise<{ data: OutfitSuggestion[]; usage: UsageMetadata }> {
  const preFilterEnabled = process.env.DISCOVER_PREFILTER_ENABLED === 'true'
    || process.env.DISCOVER_PREFILTER_ENABLED === '1'

  const hasPreRanked = preRankedItems !== undefined && preRankedItems.length > 0
  let shortlisted: Item[] | undefined = hasPreRanked ? preRankedItems : undefined
  let shortlistSource: 'text' | 'image' | 'full' = 'full'

  if (!hasPreRanked && preFilterEnabled && shouldUsePreFilter(items.length)) {
    try {
      if (imageBase64) {
        const topIds = await topKImageFromBuffer(
          Buffer.from(imageBase64, 'base64'),
          embedImage,
          userId,
          PRE_FILTER_K,
        )
        if (topIds.length >= PRE_FILTER_K) {
          const topSet = new Set(topIds)
          shortlisted = items.filter(i => topSet.has(i.id))
          shortlistSource = 'image'
        }
      }

      if (shortlisted === undefined) {
        const topIds = await topKText(contextText, embedText, userId, 'item', 'main', PRE_FILTER_K)
        if (topIds.length >= PRE_FILTER_K) {
          const topSet = new Set(topIds)
          shortlisted = items.filter(i => topSet.has(i.id))
          shortlistSource = 'text'
        }
      }
    } catch {
      // fall through to full
    }
  }

  if (shortlisted === undefined) {
    shortlisted = items
  }

  // ─── Jev-Noul ranking of shortlisted items (Phase 2, issue #281) ────────────
  // One Noul per shortlisted item keyed on inspiration state (contextText +
  // weather + occasion). Jev-Noul has no vision input — image-mode inspiration
  // was already analysed to text by the upstream Gemini Vision call
  // (analyzeInspiration), so contextText carries the descriptors here.
  // Falls back to the Gemini compose path below on HTTP error OR when the
  // shortlist is empty (graceful-degradation — user still deserves results).
  // NOT a feature-flag branch. 0 users → ship it live.
  if (shortlisted.length > 0) {
    try {
      const ranked = hasPreRanked
        ? shortlisted
        : await rankItemsWithJev(contextText, shortlisted, weather, userId, occasion)
      if (ranked.length > 0) {
        // Two-stage composition: Jev ranks, Gemini composes outfits from the
        // top-N Jev-ranked items (names + prose reasoning come back here).
        const { data: suggestions, usage } = await composeOutfitsWithGemini(
          ranked.slice(0, JEV_COMPOSE_TOP_N),
          contextText,
          weather,
          occasion,
        )
        if (suggestions.length > 0) {
          if (discoverMode !== 'shared') {
            logDiscoverEvent({
              userId,
              mode: discoverMode !== 'prompt' ? discoverMode : (imageBase64 ? 'image' : 'prompt'),
              shortlistSource: 'jev',
              itemCount: items.length,
              shortlistedCount: shortlisted.length,
              suggestionCount: suggestions.length,
              preFilterEnabled,
              occasion,
              promptChars: contextText.length,
            })
          }
          // Return Gemini's real usage (the Jev cost is captured separately by
          // runInstrumentedDecisions). The route's outer runInstrumented records
          // the Gemini compose cost from this usage; user-facing billedTokens
          // (discoverCallTokens) is still charged once by the route.
          return { data: suggestions, usage }
        }
      }
    } catch (err) {
      // HTTP error (or any failure) → Gemini fallback. Not a flag branch; the
      // Jev ai_calls row is already recorded with success=0 by
      // runInstrumentedDecisions, so this is observable in metrics.
      console.warn('[discover] Jev-Noul ranking failed — falling back to Gemini compose:', String((err as Error).message ?? err))
    }
  }

  // ─── Gemini compose fallback (today's path, full shortlist) ────────────────
  const { data: suggestions, usage } = await composeOutfitsWithGemini(shortlisted, contextText, weather, occasion)

  // Shared-mode telemetry is logged by the route (topKHybrid pre-filter).
  // prompt/image are inferred from imageBase64 presence when discoverMode omitted.
  if (discoverMode !== 'shared') {
    logDiscoverEvent({
      userId,
      mode: discoverMode !== 'prompt' ? discoverMode : (imageBase64 ? 'image' : 'prompt'),
      shortlistSource,
      itemCount: items.length,
      shortlistedCount: shortlisted.length,
      suggestionCount: suggestions.length,
      preFilterEnabled,
      occasion,
      promptChars: contextText.length,
    })
  }

  return { data: suggestions, usage }
}

// ─── Gemini compose ────────────────────────────────────────────────────────────

/** Per-item JSON summary embedded in the Gemini prompt. */
function buildItemSummary(item: Item) {
  return {
    id: item.id,
    category: item.category,
    subcategory: item.subcategory,
    primaryColor: item.primaryColor,
    material: item.material,
    season: (() => { try { return JSON.parse(item.season ?? '[]') } catch { return [] } })(),
    tags: (() => { try { return JSON.parse(item.tags ?? '[]') } catch { return [] } })(),
    occasion: (() => { try { return JSON.parse(item.occasion ?? '[]') } catch { return [] } })(),
    wearContext: item.wearContext,
  }
}

/**
 * Ask Gemini to compose 2 outfits from the given item subset. This is the
 * composition step that Jev cannot do (no prose, no outfit assembly) — shared
 * by the Jev-path subset (top-N ranked items) and the fallback (full shortlist).
 */
async function composeOutfitsWithGemini(
  items: Item[],
  contextText: string,
  weather: WeatherData | undefined,
  occasion: string | undefined,
): Promise<{ data: OutfitSuggestion[]; usage: UsageMetadata }> {
  const itemSummary = items.map(buildItemSummary)

  const weatherClause = weather
    ? `\nCurrent weather context: ${weather.temperature}°C, ${weather.condition}.`
    : ''

  const occasionClause = occasion
    ? `\nThe user is dressing for: ${occasion}.`
    : ''

  const prompt = `You are a personal stylist. Based on the context below, select 2 outfit combinations from this wardrobe.
Prioritise matching the described vibe over weather — weather is secondary context only.

Context: ${contextText}${occasionClause}${weatherClause}

From the wardrobe below, suggest 2 outfit combinations that match this context.
Return ONLY a valid JSON array with no markdown:
[
  {
    "item_ids": ["id1", "id2", "id3"],
    "name": "Outfit name",
    "occasion": "casual|work|outdoor|formal|date",
    "reasoning": "1 sentence why this matches the context"
  }
]

Wardrobe items:
${JSON.stringify(itemSummary, null, 2)}`

  return generateJSONWithUsage<OutfitSuggestion[]>(prompt, undefined, freeTextModel())
}

// ─── Jev-Noul ranking helpers ──────────────────────────────────────────────────

/**
 * Build Jev state for discover. Carries the inspiration context (user-typed
 * text in Prompt mode, or Gemini-Vision-extracted descriptors in Image mode)
 * verbatim — this is intentional and privacy-notice-flagged (issue #281 §
 * "State sanitization"). No lat/lon, no `user_*` keys (defensive rail in
 * decisions.ts catches those). Weather values only (rounded upstream by
 * weather.ts).
 */
function buildJevState(
  contextText: string,
  weather: WeatherData | undefined,
  occasion: string | undefined,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    inspiration: contextText,
  }
  if (weather) {
    state.weather = {
      temperature_c: weather.temperature,
      condition: weather.condition,
      precipitation_mm: weather.precipitation,
      wind_kmh: weather.windSpeed,
    }
  }
  if (occasion) state.occasion = occasion
  return state
}

/**
 * Shared batched-Noul core: one Noul question per item, ranked by descending
 * Noul score (answer.noul ∈ [0,1]). Items whose answers are missing (partial
 * provider response) are dropped — callers guard by comparing lengths.
 */
async function noulRankItems(
  userId: string,
  state: Record<string, unknown>,
  items: Item[],
  instructionsFor: (item: Item) => string,
): Promise<Item[]> {
  const questions: DecisionsQuestions = {}
  for (const item of items) {
    questions[`q_${item.id}`] = { type: 'noul', instructions: instructionsFor(item) }
  }

  const result = await runInstrumentedDecisions({
    userId,
    task: 'discover',
    call: async () => generateDecisions(state, questions),
  })

  const scored: Array<{ item: Item; score: number }> = []
  for (const item of items) {
    const ans = result.answers[`q_${item.id}`]
    if (!ans || ans.type !== 'noul') continue
    scored.push({ item, score: ans.noul })
  }
  scored.sort((a, b) => b.score - a.score)

  return scored.map(({ item }) => item)
}

/**
 * Rank the shortlisted items with a batched Jev-Noul call (one Noul per item:
 * "does this item match the inspiration vibe?"). Returns the items in descending
 * Noul order — the caller then hands the top-N to Gemini for composition.
 */
async function rankItemsWithJev(
  contextText: string,
  shortlisted: Item[],
  weather: WeatherData | undefined,
  userId: string,
  occasion: string | undefined,
): Promise<Item[]> {
  const state = buildJevState(contextText, weather, occasion)
  return noulRankItems(userId, state, shortlisted, (item) =>
    `Does this closet item match the described inspiration vibe? Item JSON: ${JSON.stringify(itemDecisionBlob(item))}`,
  )
}

/**
 * Rank the pool for inspiration modes (prompt / image / shared) — the #330 fix.
 * Without it, prompt mode with the prefilter off (or no item vectors) showed
 * the whole closet newest-first, so "Based on these items" was identical for
 * every prompt. Same Noul question as the compose ranking, so the route can
 * hand the result to matchClosetToContext as `preRanked` (one Jev call).
 */
export async function rankItemsForInspirationWithJev(opts: {
  userId: string
  contextText: string
  items: Item[]
  weather?: WeatherData
  occasion?: string
}): Promise<Item[]> {
  const { userId, contextText, items, weather, occasion } = opts
  if (items.length === 0) return []
  return rankItemsWithJev(contextText, items, weather, userId, occasion)
}

/**
 * Rank candidate items by occasion fit under the current weather — the pool-level
 * fix for #282. The text-embedding prefilter can't separate "casual outfit, 15°C"
 * from "work outfit, 15°C" (they differ by one token in ~15), so the embedding
 * top-K pool comes back near-identical for every occasion. Jev sees the
 * structured state (`occasion` + `weather` fields) and orders the pool by Noul
 * ("how well does this item fit a {occasion} outfit?"), so reshuffle windows
 * actually change with the occasion selection. Callers keep the embedding order
 * on failure (or adopt only when every item received a score).
 */
export async function rankItemsForOccasionWithJev(opts: {
  userId: string
  contextText: string
  items: Item[]
  weather?: WeatherData
  occasion?: string
}): Promise<Item[]> {
  const { userId, contextText, items, weather, occasion } = opts
  if (items.length === 0) return []
  const state = buildJevState(contextText, weather, occasion)

  const occasionClause = occasion ? ` for a ${JSON.stringify(occasion)} occasion` : ''
  const weatherClause = weather ? ' under the given weather conditions' : ''

  return noulRankItems(userId, state, items, (item) =>
    `How well does this closet item fit${occasionClause}${weatherClause}? Item JSON: ${JSON.stringify(itemDecisionBlob(item))}`,
  )
}

/**
 * Rank saved outfits with a batched Jev-Noul call — "does this saved outfit
 * match the inspiration?". Returns outfit IDs in descending Noul order, only
 * those clearing `minScore`. Throws on Jev HTTP error so callers can fall
 * back to text-embedding retrieval.
 */
export async function rankSavedOutfitsWithJev(
  contextText: string,
  savedOutfits: Outfit[],
  itemsById: Map<string, Item>,
  userId: string,
  weather: WeatherData | undefined,
  occasion: string | undefined,
  minScore: number,
): Promise<string[]> {
  if (savedOutfits.length === 0) return []
  const state = buildJevState(contextText, weather, occasion)

  const questions: DecisionsQuestions = {}
  const kept: Outfit[] = []
  for (const outfit of savedOutfits) {
    const blob = outfitDecisionBlob(outfit, itemsById)
    if (blob.items.length === 0) continue
    kept.push(outfit)
    questions[`q_${outfit.id}`] = {
      type: 'noul',
      instructions: `Does this saved outfit match the described inspiration? Outfit: ${JSON.stringify(blob)}`,
    }
  }
  if (kept.length === 0) return []

  const result = await runInstrumentedDecisions({
    userId,
    task: 'discover',
    call: async () => generateDecisions(state, questions),
  })

  const scored: Array<{ id: string; score: number }> = []
  for (const outfit of kept) {
    const ans = result.answers[`q_${outfit.id}`]
    if (!ans || ans.type !== 'noul') continue
    if (ans.noul >= minScore) scored.push({ id: outfit.id, score: ans.noul })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map(s => s.id)
}
