import { fetchForecast, fetchWeather, geocodeCity } from '../weather/fetch.js'
import type { ForecastDay, WeatherData } from '../types/index.js'

/**
 * Round a coordinate to the nearest 0.5°. Prevents home-address leakage when
 * lat/lon flow into a third-party processor (Jev/TypeSafe state for suggest —
 * issue #275 § "Weather rounding"). 0.5° ≈ 55km, coarse enough to dissociate the
 * value from a street address while keeping the weather cell accurate.
 */
export function roundCoord(value: number): number {
  return Math.round(value * 2) / 2
}

// ─── Cache (per 0.5° cell) ─────────────────────────────────────────────────────
// Weather for a grid cell isn't personal data, so one entry serves every user
// in that cell. This keeps us well under Open-Meteo's per-IP limit, and a
// stale value is served if every upstream is down rather than a 500.

const CURRENT_TTL_MS = 15 * 60_000
const FORECAST_TTL_MS = 60 * 60_000
const STALE_MAX_MS = 6 * 60 * 60_000
const MAX_ENTRIES = 2_000

const cache = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < ttl) return hit.value as T
  try {
    const value = await load()
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
    cache.set(key, { at: now, value })
    return value
  } catch (err) {
    if (hit && now - hit.at < STALE_MAX_MS) return hit.value as T
    throw err
  }
}

/** Tests only. */
export function resetWeatherCache(): void {
  cache.clear()
}

export async function getCurrentWeather(lat: number, lon: number): Promise<WeatherData> {
  // Coarsen before any downstream call so raw lat/lon never reach suggest.ts's
  // Jev state. Open-Meteo already treats inputs as a grid cell; rounding is a
  // no-op on weather accuracy. Intentional trade-off: privacy (preventing
  // home-address leakage to a third-party processor) > ~55km precision, which
  // is imperceptible for outfit-suggestion quality.
  const la = roundCoord(lat)
  const lo = roundCoord(lon)
  return cached(`now:${la},${lo}`, CURRENT_TTL_MS, () => fetchWeather(la, lo))
}

/** Daily forecast; coords are coarsened exactly like getCurrentWeather. */
export async function getForecast(lat: number, lon: number, startDate: string, endDate: string): Promise<ForecastDay[]> {
  const la = roundCoord(lat)
  const lo = roundCoord(lon)
  return cached(`fc:${la},${lo}:${startDate}:${endDate}`, FORECAST_TTL_MS, () => fetchForecast(la, lo, startDate, endDate))
}

export { geocodeCity }
