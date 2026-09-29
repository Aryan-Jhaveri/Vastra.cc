import { getWeatherLabel, getWeatherIcon } from './wmo.js'
import type { ForecastDay, WeatherData } from '../types/index.js'
import { normalizeTimeZone } from '../time/zone.js'

const BASE_URL = 'https://api.open-meteo.com/v1/forecast'
const CUSTOMER_URL = 'https://customer-api.open-meteo.com/v1/forecast'
const MET_NO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
// MET Norway's terms require an identifying User-Agent.
const MET_NO_USER_AGENT = 'Vastra/1.0 https://vastra.cc'
const TIMEOUT_MS = 8_000

/**
 * The free Open-Meteo API rate-limits by IP, and Render's egress IPs are
 * shared — so prod can get 429s it didn't cause. OPEN_METEO_API_KEY switches
 * to the paid customer endpoint (#19); read per call.
 */
function openMeteo(query: string): string {
  const key = process.env.OPEN_METEO_API_KEY
  return key ? `${CUSTOMER_URL}?${query}&apikey=${encodeURIComponent(key)}` : `${BASE_URL}?${query}`
}
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'

export interface GeoResult {
  lat: number
  lon: number
  name: string
  /** ISO 3166-1 alpha-2 (e.g. "CA"), when Open-Meteo returns one. */
  countryCode?: string
}

export async function geocodeCity(city: string): Promise<GeoResult> {
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding error: ${res.status}`)
  const data = await res.json() as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string; country_code?: string }> }
  if (!data.results?.length) throw new Error(`Could not find location: "${city}"`)
  const r = data.results[0]
  return {
    lat: r.latitude,
    lon: r.longitude,
    name: r.country ? `${r.name}, ${r.country}` : r.name,
    ...(r.country_code ? { countryCode: r.country_code.toUpperCase() } : {}),
  }
}

interface OpenMeteoResponse {
  timezone?: string
  current: {
    temperature_2m: number
    weather_code: number
    precipitation: number
    wind_speed_10m: number
  }
}

/**
 * Current weather: Open-Meteo, falling back to MET Norway when Open-Meteo
 * fails (429 on a shared IP, 5xx, timeout). Throws only if both fail.
 */
export async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
  try {
    return await fetchOpenMeteoCurrent(lat, lon)
  } catch (err) {
    console.warn('[weather] Open-Meteo failed, trying MET Norway:', String((err as Error).message ?? err))
    try {
      return await fetchMetNoCurrent(lat, lon)
    } catch (fallbackErr) {
      console.warn('[weather] MET Norway failed too:', String((fallbackErr as Error).message ?? fallbackErr))
      throw err
    }
  }
}

async function fetchOpenMeteoCurrent(lat: number, lon: number): Promise<WeatherData> {
  const url = openMeteo(`latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,precipitation,wind_speed_10m&temperature_unit=celsius&timezone=auto`)
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status} ${res.statusText}`)
  const data = await res.json() as OpenMeteoResponse
  const c = data.current
  const timezone = normalizeTimeZone(data.timezone)
  return {
    temperature: c.temperature_2m,
    weatherCode: c.weather_code,
    condition: getWeatherLabel(c.weather_code),
    precipitation: c.precipitation,
    windSpeed: c.wind_speed_10m,
    icon: getWeatherIcon(c.weather_code),
    ...(timezone ? { timezone } : {}),
  }
}

interface OpenMeteoDailyResponse {
  daily: {
    time: string[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    weather_code: number[]
    precipitation_probability_max?: (number | null)[]
    precipitation_sum: number[]
    wind_speed_10m_max: number[]
  }
}

/**
 * Daily forecast for `startDate`..`endDate` (YYYY-MM-DD, local to the
 * location via timezone=auto). Open-Meteo serves up to 16 days ahead and
 * rejects ranges outside that window with a 400.
 */
export async function fetchForecast(lat: number, lon: number, startDate: string, endDate: string): Promise<ForecastDay[]> {
  const daily = 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum,wind_speed_10m_max'
  const url = openMeteo(`latitude=${lat}&longitude=${lon}&daily=${daily}&timezone=auto&start_date=${startDate}&end_date=${endDate}&temperature_unit=celsius`)
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status} ${res.statusText}`)
  const d = (await res.json() as OpenMeteoDailyResponse).daily
  return d.time.map((date, i) => ({
    date,
    tempMax: d.temperature_2m_max[i],
    tempMin: d.temperature_2m_min[i],
    weatherCode: d.weather_code[i],
    condition: getWeatherLabel(d.weather_code[i]),
    icon: getWeatherIcon(d.weather_code[i]),
    precipitationProbability: d.precipitation_probability_max?.[i] ?? null,
    precipitationSum: d.precipitation_sum[i],
    windSpeedMax: d.wind_speed_10m_max[i],
  }))
}

// ─── MET Norway fallback ───────────────────────────────────────────────────────

interface MetNoResponse {
  properties: {
    timeseries: Array<{
      data: {
        instant: { details: { air_temperature: number; wind_speed?: number } }
        next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } }
        next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } }
      }
    }>
  }
}

/** MET Norway symbol (minus _day/_night/_polartwilight) → the closest WMO code. */
export function metNoSymbolToWmo(symbol: string): number {
  const s = symbol.replace(/_(day|night|polartwilight)$/, '')
  if (s.includes('thunder')) return 95
  const table: Record<string, number> = {
    clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
    lightrain: 61, rain: 63, heavyrain: 65,
    lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
    lightsleet: 66, sleet: 67, heavysleet: 67,
    lightsleetshowers: 66, sleetshowers: 67, heavysleetshowers: 67,
    lightsnow: 71, snow: 73, heavysnow: 75,
    lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
  }
  return table[s] ?? 3
}

async function fetchMetNoCurrent(lat: number, lon: number): Promise<WeatherData> {
  // MET asks for at most 4 decimals; callers already pass 0.5° cells.
  const url = `${MET_NO_URL}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`
  const res = await fetch(url, { headers: { 'User-Agent': MET_NO_USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`MET Norway error: ${res.status} ${res.statusText}`)
  const now = (await res.json() as MetNoResponse).properties.timeseries[0]?.data
  if (!now) throw new Error('MET Norway returned no data')
  const next = now.next_1_hours ?? now.next_6_hours
  const code = metNoSymbolToWmo(next?.summary?.symbol_code ?? 'cloudy')
  return {
    temperature: now.instant.details.air_temperature,
    weatherCode: code,
    condition: getWeatherLabel(code),
    precipitation: next?.details?.precipitation_amount ?? 0,
    // m/s → km/h, to match Open-Meteo's default unit.
    windSpeed: Math.round((now.instant.details.wind_speed ?? 0) * 3.6 * 10) / 10,
    icon: getWeatherIcon(code),
  }
}
