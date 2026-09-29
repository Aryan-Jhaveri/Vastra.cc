import { generateJSONWithUsage } from './client.js'
import { freeTextModel } from './localModel.js'
import { generateDecisions, type DecisionsQuestions, type NoulQuestion } from './decisions.js'
import { runInstrumented, runInstrumentedDecisions } from './instrumented.js'
import type { AgentCallIdentity } from './messages.js'
import { listOutfits } from '../tools/outfits.js'
import type { WeatherData, Item, Outfit, OutfitSuggestion } from '../types/index.js'
import { topKText, shouldUsePreFilter } from '../storage/embeddings.js'
import { embedText } from './embed.js'
import { logSuggestEvent } from './suggestEvents.js'
import { outfitDecisionBlob } from './decisionText.js'

const PRE_FILTER_K = 12
const JEV_TOP_N = 2

function getTimeOfDay(hour: number): string {
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  if (hour < 20) return 'evening'
  return 'night'
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weatherContext(weather: WeatherData, theme?: string, occasion?: string): string {
  const base = `${weather.temperature}°C ${weather.condition} precip ${weather.precipitation}mm wind ${weather.windSpeed}km/h`
  const parts = [base]
  if (theme) parts.push(`theme: ${theme}`)
  if (occasion) parts.push(`occasion: ${occasion}`)
  return parts.join(' ')
}

/**
 * Jev-Noul state for the suggest ranking call. Object form (no lat/lon, no
 * `user_*` keys) — matches `fixture_state_enriched` from notebook 21. Raw
 * coordinates never reach a third-party processor (issue #275 § "Weather
 * rounding"); only resolved weather values are sent.
 */
export function buildJevState(
  weather: WeatherData,
  theme: string | undefined,
  occasion: string | undefined,
  timeOfDay: string | null,
  dayName: string | null,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    weather: {
      temperature_c: weather.temperature,
      condition: weather.condition,
      precipitation_mm: weather.precipitation,
      wind_kmh: weather.windSpeed,
    },
    occasion: occasion ?? null,
    time_of_day: timeOfDay ?? null,
    day_of_week: dayName ?? null,
    theme: theme ?? null,
  }
  return state
}

/** One suggest Noul question. Exported so the #296 benchmark builds identical fixtures. */
export function suggestOutfitQuestion(blob: unknown): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Is this outfit a good pick for the given context? Outfit JSON: ${JSON.stringify(blob)}`,
  }
}

/**
 * Rank the user's saved outfits with a batched Jev-Noul call (one Noul per
 * outfit: "is this outfit a good pick for {weather, occasion, time, day,
 * theme}?"). Returns the top-N as OutfitSuggestion[], preserving today's
 * return shape (item_ids/name/occasion/reasoning). Jev cannot write prose, so
 * the reasoning is a short synthesized line carrying the Noul score.
 */
async function rankOutfitsWithJev(
  weather: WeatherData,
  closetItems: Item[],
  userId: string,
  theme: string | undefined,
  occasion: string | undefined,
  timeOfDay: string | null,
  dayName: string | null,
  jobId: string | undefined,
  identity?: AgentCallIdentity,
): Promise<OutfitSuggestion[]> {
  const outfits = await listOutfits({}, userId)
  if (outfits.length === 0) return []

  const itemsById = new Map(closetItems.map(i => [i.id, i]))
  const state = buildJevState(weather, theme, occasion, timeOfDay, dayName)

  const questions: DecisionsQuestions = {}
  for (const outfit of outfits) {
    const blob = outfitDecisionBlob(outfit, itemsById)
    // Skip outfits whose items were all deleted — Jev would rank an empty
    // outfit, polluting the result.
    if (!blob.items.length) continue
    questions[`q_${outfit.id}`] = suggestOutfitQuestion(blob)
  }
  if (Object.keys(questions).length === 0) return []

  const result = await runInstrumentedDecisions({
    userId,
    task: 'suggest',
    jobId,
    ...identity,
    call: async () => generateDecisions(state, questions),
  })

  // Rank by descending Noul score (answer.noul ∈ [0,1]).
  const scored: Array<{ outfit: Outfit; score: number }> = []
  for (const outfit of outfits) {
    const ans = result.answers[`q_${outfit.id}`]
    if (!ans || ans.type !== 'noul') continue
    scored.push({ outfit, score: ans.noul })
  }
  scored.sort((a, b) => b.score - a.score)

  const weatherLine = `${weather.temperature}°C ${weather.condition}`
  return scored.slice(0, JEV_TOP_N).map(({ outfit, score }) => {
    const itemIds: string[] = JSON.parse(outfit.itemIds ?? '[]')
    return {
      item_ids: itemIds,
      name: outfit.name,
      occasion: outfit.occasion ?? 'casual',
      reasoning: `Jev-Noul score ${score.toFixed(2)} for ${weatherLine}${occasion ? ' · ' + occasion : ''}.`,
    }
  })
}

export async function suggestOutfits(
  weather: WeatherData,
  closetItems: Item[],
  userId = 'self',
  theme?: string,
  occasion?: string,
  localHour?: number,
  localDay?: number,
  jobId?: string,
  identity?: AgentCallIdentity,
): Promise<OutfitSuggestion[]> {
  const preFilterEnabled = process.env.SUGGEST_PREFILTER_ENABLED === 'true'
    || process.env.SUGGEST_PREFILTER_ENABLED === '1'

  let shortlisted: Item[]

  // shortlistSource: 'text' | 'image' | 'hybrid' | 'full' (image/hybrid are
  // forward-compat for branches 4/5 — suggest.ts only ever writes text or full).
  let shortlistSource: 'text' | 'image' | 'hybrid' | 'full' = 'full'

  if (preFilterEnabled && shouldUsePreFilter(closetItems.length)) {
    try {
      const context = weatherContext(weather, theme, occasion)
      const topIds = await topKText(context, embedText, userId, 'item', 'main', PRE_FILTER_K)
      const topSet = new Set(topIds)
      shortlisted = closetItems.filter(i => topSet.has(i.id))

      if (shortlisted.length >= PRE_FILTER_K) {
        shortlistSource = 'text'
      } else {
        // shortlisted > 0 but < K means partial backfill — fall through to
        // full closet but log via shortlisted_count for operator visibility
        shortlisted = closetItems
      }
    } catch {
      shortlisted = closetItems
    }
  }

  if (shortlisted! === undefined) {
    shortlisted = closetItems
  }

  const itemSummary = shortlisted.map(i => ({
    id: i.id,
    category: i.category,
    subcategory: i.subcategory,
    primaryColor: i.primaryColor,
    material: i.material,
    season: JSON.parse(i.season ?? '[]'),
    tags: JSON.parse(i.tags ?? '[]'),
    occasion: JSON.parse(i.occasion ?? '[]'),
  }))

  const themeClause = theme ? `\nAdditional context: ${theme}` : ''
  const occasionClause = occasion ? `\nThe user is dressing for: ${occasion}.` : ''

  const timeOfDay = localHour !== undefined ? getTimeOfDay(localHour) : null
  const dayName = localDay !== undefined ? DAY_NAMES[localDay] : null

  const timeClause = timeOfDay
    ? `\nTime of day: ${timeOfDay} — factor this into accessory choices (sunglasses/hats suit morning/afternoon, not evening/night).`
    : ''
  const dayClause = dayName
    ? `\nDay: ${dayName} — lean toward work/formal styles on weekdays, relaxed/casual on weekends unless occasion overrides.`
    : ''

  // Fixed instructions and the wardrobe come first and today's context last.
  // Model servers (vLLM, llama.cpp) and hosted APIs reuse cached work for a
  // prompt's shared beginning; leading with the weather, which changes every
  // call, meant nothing could be reused (#289).
  const prompt = `Suggest 2 outfit combinations from the wardrobe below, suited to today's context (given after the wardrobe).
Return ONLY a valid JSON array with no markdown:
[
  {
    "item_ids": ["id1", "id2", "id3"],
    "name": "Outfit name",
    "occasion": "casual|work|outdoor|formal",
    "reasoning": "1 sentence why this works for the weather"
  }
]

Wardrobe items:
${JSON.stringify(itemSummary, null, 2)}

Today's context:
Weather: ${weather.temperature}°C, ${weather.condition}, ${weather.precipitation}mm rain expected, wind ${weather.windSpeed}km/h.${themeClause}${occasionClause}${timeClause}${dayClause}

Pick outfits appropriate for this weather${theme ? ' and the additional context above' : ''}${occasion ? ' and the occasion' : ''}.`

  // Free task: Gemini, or a local/ TEXT_MODEL (see freeTextModel).
  const suggestModel = freeTextModel()

  // ─── Jev-Noul ranking of saved outfits (Phase 1, issue #275) ────────────────
  // One Noul per saved outfit, batched in a single /api/alpha/decisions call.
  // Falls back to the Gemini compose path below on HTTP error (network / 4xx /
  // 5xx) OR when Jev returns 0 suggestions — the latter is a graceful-degradation
  // path, not an error path: a user with 0 saved outfits (or whose outfits all
  // point to deleted items) still deserves suggestions, and Gemini's
  // compose-from-items is the only way to give them one. NOT a feature-flag
  // branch. 0 users → ship it live; revert the commit if broken.
  try {
    const suggestions = await rankOutfitsWithJev(
      weather, closetItems, userId, theme, occasion, timeOfDay, dayName, jobId, identity,
    )
    if (suggestions.length > 0) {
      logSuggestEvent({
        userId,
        shortlistSource: 'jev',
        itemCount: closetItems.length,
        shortlistedCount: closetItems.length,
        suggestionCount: suggestions.length,
        preFilterEnabled,
        weather: weatherContext(weather, theme, occasion),
        occasion,
        promptChars: 0,
      })
      return suggestions
    }
  } catch (err) {
    // HTTP error (or any failure) → Gemini fallback. Not a flag branch; the
    // Jev ai_calls row is already recorded with success=0 by
    // runInstrumentedDecisions, so this is observable in metrics.
    console.warn('[suggest] Jev-Noul ranking failed — falling back to Gemini compose:', String((err as Error).message ?? err))
  }

  // ─── Gemini compose fallback (today's path) ────────────────────────────────
  const suggestions = await runInstrumented({
    userId,
    task: 'suggest',
    model: suggestModel,
    expectedBilledTokens: 0,
    jobId,
    ...identity,
    call: async (_ctx) => {
      const { data, usage } = await generateJSONWithUsage<OutfitSuggestion[]>(prompt, undefined, suggestModel)
      return { result: data, usage }
    },
  })

  logSuggestEvent({
    userId,
    shortlistSource,
    itemCount: closetItems.length,
    shortlistedCount: shortlisted.length,
    suggestionCount: suggestions.length,
    preFilterEnabled,
    weather: weatherContext(weather, theme, occasion),
    occasion,
    promptChars: prompt.length,
  })

  return suggestions
}
