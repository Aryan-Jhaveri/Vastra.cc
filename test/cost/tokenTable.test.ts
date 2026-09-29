import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeWholesaleCost, COST_UNITS_PER_USD, priceScheduleAt, TOKEN_COST } from '../../src/cost/tokenTable.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('computeWholesaleCost', () => {
  it('gemini:gemini-2.5-flash — (1000 in, 500 out)', () => {
    expect(computeWholesaleCost('gemini', 'gemini-2.5-flash', { tokensIn: 1000, tokensOut: 500 })).toBe(155)
  })

  it('gemini:gemini-flash-latest — same pricing as 2.5-flash', () => {
    expect(computeWholesaleCost('gemini', 'gemini-flash-latest', { tokensIn: 1000, tokensOut: 500 })).toBe(155)
  })

  it('gemini:gemini-3.1-flash-image-preview (NB2) — per-token, ~$0.067/1K image', () => {
    // 1120 output tokens/image × $60/M = $0.0672 → 6720 in $ × 100_000 units
    const cost = computeWholesaleCost('gemini', 'gemini-3.1-flash-image-preview', { tokensIn: 0, tokensOut: 1120 })
    expect(cost).toBeGreaterThanOrEqual(6600)
    expect(cost).toBeLessThanOrEqual(6800)
    // Regression: the old flat-390 bug must not return — a per-1K-image call
    // costs far more than 500 ($0.005).
    expect(cost).toBeGreaterThan(500)
  })

  it('gemini:gemini-3.1-flash-lite-image (NB2 Lite) — per-token, ~$0.034/1K image', () => {
    // 1120 output tokens/image × $30/M = $0.0336 → 3360 in $ × 100_000 units
    const cost = computeWholesaleCost('gemini', 'gemini-3.1-flash-lite-image', { tokensIn: 0, tokensOut: 1120 })
    expect(cost).toBeGreaterThanOrEqual(3300)
    expect(cost).toBeLessThanOrEqual(3500)
  })

  it('gemini:gemini-3-pro-image (NB Pro) — per-token, ~$0.134/1K image', () => {
    // 1120 output tokens/image × $120/M = $0.1344 → 13440 in $ × 100_000 units
    const cost = computeWholesaleCost('gemini', 'gemini-3-pro-image', { tokensIn: 0, tokensOut: 1120 })
    expect(cost).toBeGreaterThanOrEqual(13200)
    expect(cost).toBeLessThanOrEqual(13500)
  })

  it('vertex:multimodalembedding@001 — flat $0.0001 (10 units) regardless of usage', () => {
    expect(computeWholesaleCost('vertex', 'multimodalembedding@001', { tokensIn: 0, tokensOut: 0 })).toBe(10)
    expect(computeWholesaleCost('vertex', 'multimodalembedding@001', { tokensIn: 500, tokensOut: 200 })).toBe(10)
  })

  // One unit everywhere: USD × 100,000. Readers (admin metrics, chat spend
  // cap, spend reconciler) divided by 10,000 and showed costs 10× too high.
  it('COST_UNITS_PER_USD matches the per-token table ($0.00155 → 155)', () => {
    const units = computeWholesaleCost('gemini', 'gemini-2.5-flash', { tokensIn: 1000, tokensOut: 500 })
    expect(units / COST_UNITS_PER_USD).toBeCloseTo(0.00155, 8)
  })

  it('gemini:gemini-embedding-001 — (1000 in, 500 out)', () => {
    expect(computeWholesaleCost('gemini', 'gemini-embedding-001', { tokensIn: 1000, tokensOut: 500 })).toBe(15)
  })

  it('openrouter:mistralai/mistral-small-3.2-24b-instruct — (1000 in, 500 out)', () => {
    expect(computeWholesaleCost('openrouter', 'mistralai/mistral-small-3.2-24b-instruct', { tokensIn: 1000, tokensOut: 500 })).toBe(13)
  })

  it('unknown model — returns 0 and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(computeWholesaleCost('openai', 'gpt-unknown', { tokensIn: 1000, tokensOut: 500 })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('wholesale cost not configured')
    computeWholesaleCost('openai', 'gpt-unknown', { tokensIn: 1000, tokensOut: 500 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('has prices for all expected models', () => {
    const expected = [
      'gemini:gemini-2.5-flash',
      'gemini:gemini-flash-latest',
      'gemini:gemini-3.1-flash-image-preview',
      'gemini:gemini-3.1-flash-lite-image',
      'gemini:gemini-3-pro-image',
      'vertex:multimodalembedding@001',
      'gemini:gemini-embedding-001',
      'openrouter:mistralai/mistral-small-3.2-24b-instruct',
    ]
    for (const key of expected) {
      expect(priceScheduleAt().prices[key]).toBeDefined()
    }
  })

  it('falls back to gemini pricing for vertex-labelled Gemini models (#158)', () => {
    // Calls route through Vertex (provider="vertex") but reuse the same Gemini
    // model + wholesale rate, so cost must match the gemini: entry.
    const vertexCost = computeWholesaleCost('vertex', 'gemini-2.5-flash', { tokensIn: 500, tokensOut: 100 })
    const geminiCost = computeWholesaleCost('gemini', 'gemini-2.5-flash', { tokensIn: 500, tokensOut: 100 })
    expect(vertexCost).toBe(geminiCost)
    expect(vertexCost).toBe(40)
  })

  it('falls back to gemini pricing for vertex text embedding', () => {
    expect(computeWholesaleCost('vertex', 'gemini-embedding-001', { tokensIn: 2000, tokensOut: 0 })).toBe(30)
  })

  it('prices the OpenRouter text model under its full id', () => {
    const cost = computeWholesaleCost('openrouter', 'mistralai/mistral-small-3.2-24b-instruct', { tokensIn: 1000, tokensOut: 200 })
    // 1000 * 5000 / 1e6 = 5, 200 * 15000 / 1e6 = 3 → 8
    expect(cost).toBe(8)
  })
})

describe('TOKEN_COST (#205 token gate)', () => {
  it('charges the gated tasks', () => {
    expect(TOKEN_COST.detect).toBe(2)
    expect(TOKEN_COST.ocr).toBe(1)
    expect(TOKEN_COST.suggest).toBe(1)
    expect(TOKEN_COST.discover).toBe(2)
    expect(TOKEN_COST.tryon).toBe(16)
    expect(TOKEN_COST.make_pretty).toBe(16)
  })

  it('keeps dynamically-computed / paired / free tasks at a static 0', () => {
    // suggest_reshuffle is resolved at the route (free up to 25/day then 1);
    // inspiration is the paired phase that charges on the discover call.
    expect(TOKEN_COST.suggest_reshuffle).toBe(0)
    expect(TOKEN_COST.inspiration).toBe(0)
    expect(TOKEN_COST.categorize).toBe(0)
  })
})
