import { describe, it, expect } from 'vitest'
import {
  shopQueryForWeather,
  shopQueryForPrompt,
  shopQueryForInspiration,
  shopQueryForShare,
  withWeather,
} from '../../../src/commerce/shopify/shopQuery.js'

describe('shopQueryForWeather', () => {
  it('uses garment words for the query and puts the weather in intent', () => {
    const q = shopQueryForWeather({ temperature: 12, condition: 'Cloudy', precipitation: 0 })
    expect(q.query).toBe('light jacket and layers')
    expect(q.intent).toBe('Everyday outfit for cloudy weather, around 12°C')
    // The words that matched weather stations and "Cloud" cosmetics.
    expect(q.query).not.toMatch(/cloud|weather|°C/i)
  })

  it('picks garments by temperature band', () => {
    const at = (t: number) => shopQueryForWeather({ temperature: t, condition: 'Clear', precipitation: 0 }).query
    expect(at(-5)).toBe('winter coat, knit sweater and warm boots')
    expect(at(5)).toBe('warm jacket and knit sweater')
    expect(at(15)).toBe('light jacket and layers')
    expect(at(22)).toBe('lightweight shirt and trousers')
    expect(at(30)).toBe('breathable linen shirt and shorts')
  })

  it('adds rain or snow gear', () => {
    expect(shopQueryForWeather({ temperature: 12, condition: 'Light rain', precipitation: 0 }).query)
      .toBe('waterproof rain jacket, light jacket and layers')
    expect(shopQueryForWeather({ temperature: 12, condition: 'Overcast', precipitation: 2 }).query)
      .toMatch(/^waterproof rain jacket/)
    expect(shopQueryForWeather({ temperature: -2, condition: 'Snow', precipitation: 3 }).query)
      .toBe('snow boots, winter coat, knit sweater and warm boots')
  })

  it('prefixes the chosen occasion', () => {
    const q = shopQueryForWeather({ temperature: 22, condition: 'Sunny', precipitation: 0 }, 'date night')
    expect(q.query).toBe('date night lightweight shirt and trousers')
    expect(q.intent).toBe('date night outfit for sunny weather, around 22°C')
  })
})

describe('shopQueryForInspiration', () => {
  const insp = {
    vibe: 'cozy minimalist',
    description: 'Oversized cream wool knit over wide-leg raw denim.',
    garmentHints: ['oversized wool sweater', 'wide-leg jeans', ' ', 'loafers', 'tote', 'scarf'],
  }

  it('queries the garment hints (max 4) and keeps the description for intent', () => {
    const q = shopQueryForInspiration(insp)
    expect(q.query).toBe('oversized wool sweater, wide-leg jeans, loafers, tote')
    expect(q.intent).toBe('cozy minimalist look: Oversized cream wool knit over wide-leg raw denim.')
  })

  it('falls back to the vibe when there are no hints', () => {
    expect(shopQueryForInspiration({ ...insp, garmentHints: [] }).query).toBe('cozy minimalist')
  })
})

describe('shopQueryForPrompt / shopQueryForShare', () => {
  it('passes the text through, trimmed and clipped on a word boundary', () => {
    expect(shopQueryForPrompt('  linen   shirt  ')).toEqual({ query: 'linen shirt' })
    const long = shopQueryForShare('word '.repeat(80))
    expect(long.query.length).toBeLessThanOrEqual(200)
    expect(long.query.endsWith('word')).toBe(true)
  })
})

describe('withWeather', () => {
  const weather = { temperature: 11.6, condition: 'Light rain', precipitation: 1 }

  it('adds the current weather to the intent', () => {
    expect(withWeather({ query: 'date night' }, weather)).toEqual({
      query: 'date night',
      intent: 'Current weather: light rain, around 12°C',
    })
    expect(withWeather({ query: 'q', intent: 'cozy look' }, weather).intent)
      .toBe('cozy look. Current weather: light rain, around 12°C')
  })

  it('leaves the search alone without weather', () => {
    expect(withWeather({ query: 'q' }, undefined)).toEqual({ query: 'q' })
  })
})
