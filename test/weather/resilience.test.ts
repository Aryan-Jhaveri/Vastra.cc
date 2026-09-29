import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCurrentWeather, getForecast } from '../../src/tools/weather.js'
import { metNoSymbolToWmo } from '../../src/weather/fetch.js'

// Prod outage 2026-09-26: Open-Meteo returned 429 to Render's shared egress IP
// and /api/weather + Discover "Today's Outfit" 500'd. These pin the fallback,
// the per-cell cache and the stale-on-error path.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const openMeteoOk = (t: number) => json({ current: { temperature_2m: t, weather_code: 3, precipitation: 0, wind_speed_10m: 10 } })
const metNoOk = json({ properties: { timeseries: [{ data: {
  instant: { details: { air_temperature: 19.6, wind_speed: 5 } },
  next_1_hours: { summary: { symbol_code: 'lightrain_day' }, details: { precipitation_amount: 0.4 } },
} }] } })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OPEN_METEO_API_KEY
})

describe('current weather resilience', () => {
  it('falls back to MET Norway on an Open-Meteo 429, with an identifying User-Agent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.includes('open-meteo')) return new Response('slow down', { status: 429, statusText: 'Too Many Requests' })
      return metNoOk.clone()
    })
    const w = await getCurrentWeather(43.108, -79.221)
    expect(w).toMatchObject({ temperature: 19.6, weatherCode: 61, precipitation: 0.4, windSpeed: 18 })
    const met = fetchMock.mock.calls.find(c => String(c[0]).includes('api.met.no'))!
    expect(String(met[0])).toContain('lat=43.0000&lon=-79.0000') // rounded cell, not the raw coords
    expect((met[1] as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('Vastra') })
  })

  it('throws the Open-Meteo error when both providers fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input =>
      String(input).includes('open-meteo')
        ? new Response('', { status: 429, statusText: 'Too Many Requests' })
        : new Response('', { status: 503, statusText: 'Unavailable' }))
    await expect(getCurrentWeather(10, 10)).rejects.toThrow(/Open-Meteo error: 429/)
  })

  it('caches per 0.5° cell: nearby users share one upstream call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => openMeteoOk(12))
    await getCurrentWeather(43.108, -79.221)
    await getCurrentWeather(43.11, -79.19)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await getCurrentWeather(45, -79)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('serves the stale value when every upstream fails after expiry', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => openMeteoOk(7))
    await getCurrentWeather(20, 20)
    clock.mockReturnValue(now + 30 * 60_000) // past the 15-minute TTL
    vi.mocked(fetch).mockImplementation(async () => new Response('', { status: 500 }))
    expect((await getCurrentWeather(20, 20)).temperature).toBe(7)
  })

  it('uses the paid endpoint when OPEN_METEO_API_KEY is set', async () => {
    process.env.OPEN_METEO_API_KEY = 'k_123'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => openMeteoOk(1))
    await getCurrentWeather(30, 30)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/^https:\/\/customer-api\.open-meteo\.com\//)
    expect(url).toContain('apikey=k_123')
  })

  it('caches forecasts too', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ daily: {
      time: ['2026-10-02'], temperature_2m_max: [14], temperature_2m_min: [6], weather_code: [3],
      precipitation_probability_max: [10], precipitation_sum: [0], wind_speed_10m_max: [12],
    } }))
    await getForecast(43, -79, '2026-10-02', '2026-10-02')
    await getForecast(43.1, -79.1, '2026-10-02', '2026-10-02')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('metNoSymbolToWmo', () => {
  it('maps day/night variants, showers, snow and thunder', () => {
    expect(metNoSymbolToWmo('clearsky_night')).toBe(0)
    expect(metNoSymbolToWmo('partlycloudy_day')).toBe(2)
    expect(metNoSymbolToWmo('heavyrainshowers_polartwilight')).toBe(82)
    expect(metNoSymbolToWmo('snow')).toBe(73)
    expect(metNoSymbolToWmo('rainandthunder')).toBe(95)
    expect(metNoSymbolToWmo('something_new')).toBe(3)
  })
})
