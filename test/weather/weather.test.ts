import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getWeatherLabel, getWeatherIcon, WMO_CODES } from '../../src/weather/wmo.js'

// ─── WMO mapping ──────────────────────────────────────────────────────────────

describe('WMO code mapping', () => {
  it('maps code 0 to clear sky', () => {
    expect(getWeatherLabel(0)).toBe('Clear sky')
    expect(getWeatherIcon(0)).toBe('☀️')
  })

  it('maps code 63 to rain', () => {
    expect(getWeatherLabel(63)).toBe('Rain')
    expect(getWeatherIcon(63)).toBe('🌧️')
  })

  it('maps code 95 to thunderstorm', () => {
    expect(getWeatherLabel(95)).toBe('Thunderstorm')
    expect(getWeatherIcon(95)).toBe('⛈️')
  })

  it('returns Unknown for an unrecognized code', () => {
    expect(getWeatherLabel(999)).toBe('Unknown')
    expect(getWeatherIcon(999)).toBe('🌡️')
  })

  it('covers all major WMO categories', () => {
    const codes = Object.keys(WMO_CODES).map(Number)
    expect(codes).toContain(0)   // clear
    expect(codes).toContain(3)   // overcast
    expect(codes).toContain(61)  // rain
    expect(codes).toContain(71)  // snow
    expect(codes).toContain(95)  // thunderstorm
  })
})

// ─── fetchWeather (mocked HTTP) ───────────────────────────────────────────────

describe('fetchWeather', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns structured WeatherData from Open-Meteo response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 18.5,
          weather_code: 2,
          precipitation: 0,
          wind_speed_10m: 12.3,
        },
      }),
    }))

    const { fetchWeather } = await import('../../src/weather/fetch.js')
    const weather = await fetchWeather(43.7, -79.4)
    expect(weather.temperature).toBe(18.5)
    expect(weather.weatherCode).toBe(2)
    expect(weather.condition).toBe('Partly cloudy')
    expect(weather.precipitation).toBe(0)
    expect(weather.windSpeed).toBe(12.3)
    expect(weather.icon).toBe('⛅')
  })

  it("asks for the location's time zone and keeps it only when valid (#213)", async () => {
    const current = { temperature_2m: 10, weather_code: 0, precipitation: 0, wind_speed_10m: 1 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ timezone: 'America/Toronto', current }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ timezone: 'Not/AZone', current }) })
    vi.stubGlobal('fetch', fetchMock)

    const { fetchWeather } = await import('../../src/weather/fetch.js')
    expect((await fetchWeather(43.7, -79.4)).timezone).toBe('America/Toronto')
    expect(String(fetchMock.mock.calls[0][0])).toContain('timezone=auto')
    expect(await fetchWeather(43.7, -79.4)).not.toHaveProperty('timezone')
  })

  it('throws when Open-Meteo returns an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    }))

    const { fetchWeather } = await import('../../src/weather/fetch.js')
    await expect(fetchWeather(0, 0)).rejects.toThrow('Open-Meteo error: 429')
  })
})

// ─── getCurrentWeather tool ───────────────────────────────────────────────────

describe('getCurrentWeather tool', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('delegates to fetchWeather', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 5.0,
          weather_code: 71,
          precipitation: 2.5,
          wind_speed_10m: 8.0,
        },
      }),
    }))

    const { getCurrentWeather } = await import('../../src/tools/weather.js')
    const weather = await getCurrentWeather(51.5, -0.1)
    expect(weather.condition).toBe('Light snow')
    expect(weather.temperature).toBe(5.0)
    expect(weather.icon).toBe('🌨️')
  })
})
