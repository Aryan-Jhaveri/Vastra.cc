/**
 * Turn a Suggest/Discover context into a Global Catalog search (#324).
 *
 * The UCP catalog spec separates `query` (what to find) from `context.intent`
 * ("background context describing buyer's intent"). Sending the display
 * string "Today's weather: Cloudy, 12°C" as the query matched on the words —
 * weather stations and "Cloud" cosmetics — so the query here is always garment
 * words, and the situation goes in `intent`.
 *
 * Privacy: only the typed prompt, the chosen occasion, weather numbers, or the
 * AI's garment/vibe summary of an inspiration photo leave the server — never
 * closet items, user ids or the photo itself.
 */

export interface ShopQuery {
  query: string
  intent?: string
}

const MAX_QUERY = 200
const MAX_INTENT = 300

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '')
}

export interface ShopWeather {
  temperature: number
  condition: string
  precipitation: number
}

const WET = /rain|drizzle|shower|thunder|storm/i
const SNOW = /snow|sleet|ice|freezing/i

/** Garments that suit the temperature band, most important first. */
function garmentsForTemperature(t: number): string {
  if (t <= 0) return 'winter coat, knit sweater and warm boots'
  if (t <= 10) return 'warm jacket and knit sweater'
  if (t <= 17) return 'light jacket and layers'
  if (t <= 24) return 'lightweight shirt and trousers'
  return 'breathable linen shirt and shorts'
}

export function shopQueryForWeather(weather: ShopWeather, occasion?: string): ShopQuery {
  const t = Math.round(weather.temperature)
  let garments = garmentsForTemperature(t)
  if (SNOW.test(weather.condition)) garments = `snow boots, ${garments}`
  else if (WET.test(weather.condition) || weather.precipitation >= 0.5) garments = `waterproof rain jacket, ${garments}`

  const occ = occasion?.trim()
  return {
    query: clip(occ ? `${occ} ${garments}` : garments, MAX_QUERY),
    intent: clip(
      `${occ ? `${occ} outfit` : 'Everyday outfit'} for ${weather.condition.toLowerCase()} weather, around ${t}°C`,
      MAX_INTENT,
    ),
  }
}

/**
 * Add the current weather to a non-weather-mode search's intent, so a typed
 * "date night" prompt still leans toward what suits today's conditions.
 * Weather mode already carries it.
 */
export function withWeather(shop: ShopQuery, weather: ShopWeather | undefined): ShopQuery {
  if (!weather) return shop
  const note = `Current weather: ${weather.condition.toLowerCase()}, around ${Math.round(weather.temperature)}°C`
  return { ...shop, intent: clip(shop.intent ? `${shop.intent}. ${note}` : note, MAX_INTENT) }
}

export function shopQueryForPrompt(prompt: string): ShopQuery {
  return { query: clip(prompt, MAX_QUERY) }
}

export interface ShopInspiration {
  vibe: string
  description: string
  garmentHints: string[]
}

export function shopQueryForInspiration(insp: ShopInspiration): ShopQuery {
  const hints = insp.garmentHints.map(h => h.trim()).filter(Boolean).slice(0, 4)
  return {
    // Garment hints are concrete nouns ("wide-leg trousers"); the description
    // is a sentence and matches poorly as a query, so it only goes in intent.
    query: clip(hints.length ? hints.join(', ') : insp.vibe, MAX_QUERY),
    intent: clip(`${insp.vibe} look: ${insp.description}`, MAX_INTENT),
  }
}

export function shopQueryForShare(description: string): ShopQuery {
  return { query: clip(description, MAX_QUERY) }
}
