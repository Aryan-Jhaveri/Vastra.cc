import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Item, WeatherData, OutfitSuggestion } from '../../src/types/index.js'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const mockWeather: WeatherData = {
  temperature: 15,
  weatherCode: 2,
  condition: 'Partly cloudy',
  precipitation: 0,
  windSpeed: 10,
  icon: '⛅',
}

const mockItems: Item[] = [
  {
    id: 'top1', imageUri: 'images/items/top1.jpg', tagImageUri: null,
    category: 'tops', subcategory: 't-shirt', primaryColor: 'white',
    colors: '["white"]', material: 'cotton', careInstructions: '[]',
    brand: null, size: 'M', season: '["spring","summer"]', tags: '["casual"]',
    aiDescription: 'A white cotton t-shirt.', occasion: '["casual"]',
    timesWorn: 0, lastWornAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    wearContext: null,
  } as Item,
  {
    id: 'bot1', imageUri: 'images/items/bot1.jpg', tagImageUri: null,
    category: 'bottoms', subcategory: 'jeans', primaryColor: 'navy',
    colors: '["navy"]', material: 'denim', careInstructions: '[]',
    brand: 'Levi\'s', size: '32x30', season: '["spring","fall"]', tags: '["casual"]',
    aiDescription: 'Classic navy denim jeans.', occasion: '["casual","work"]',
    timesWorn: 2, lastWornAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    wearContext: null,
  } as Item,
  {
    id: 'shoe1', imageUri: 'images/items/shoe1.jpg', tagImageUri: null,
    category: 'shoes', subcategory: 'sneakers', primaryColor: 'white',
    colors: '["white"]', material: 'canvas', careInstructions: '[]',
    brand: null, size: '10', season: '["spring","summer","fall"]', tags: '["casual"]',
    aiDescription: 'White canvas sneakers.', occasion: '["casual"]',
    timesWorn: 5, lastWornAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    wearContext: null,
  } as Item,
]

// Richer fixture for cross-user isolation — 2 items per category so Jev scores
// actually change which items get picked into each outfit.
const multiItems: Item[] = [
  { ...mockItems[0]!, id: 'topA' },
  { ...mockItems[0]!, id: 'topB' },
  { ...mockItems[1]!, id: 'botA' },
  { ...mockItems[1]!, id: 'botB' },
  { ...mockItems[2]!, id: 'shoeA' },
  { ...mockItems[2]!, id: 'shoeB' },
]

// ─── Reusable mock builders ───────────────────────────────────────────────────

const geminiClientMock = (suggestions: OutfitSuggestion[]) => ({
  generateJSONWithUsage: vi.fn().mockResolvedValue({
    data: suggestions,
    usage: { tokensIn: 200, tokensOut: 100 },
  }),
  VISION_MODEL: 'gemini-2.5-flash',
  TEXT_MODEL: 'gemini-2.5-flash',
  IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
  providerForModel: () => 'gemini',
})

const discoverEventsMock = () => ({
  logDiscoverEvent: vi.fn(),
})

const embeddingsMock = (opts: {
  textIds?: string[]
  imageIds?: string[]
  preFilterEnabled?: boolean
} = {}) => ({
  topKText: vi.fn().mockResolvedValue(opts.textIds ?? []),
  topKImageFromBuffer: vi.fn().mockResolvedValue(opts.imageIds ?? []),
  shouldUsePreFilter: vi.fn().mockReturnValue(opts.preFilterEnabled ?? true),
})

const embedMock = () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) })
const embedImageMock = () => ({ embedImage: vi.fn().mockResolvedValue([0.4, 0.5, 0.6]) })

function setupJevMocks(decisionsMock: ReturnType<typeof vi.fn>) {
  vi.doMock('../../src/ai/decisions.js', () => ({
    generateDecisions: decisionsMock,
    JEV_MODEL: 'typesafe/jev-1.13',
  }))
  // Pass-through mock — avoids FK constraint on ai_calls when tests use
  // non-'self' userIds. The real runInstrumentedDecisions writes a DB row;
  // tests only care about the generateDecisions call shape + return value.
  vi.doMock('../../src/ai/instrumented.js', () => ({
    runInstrumentedDecisions: vi.fn(async (input: { call: () => Promise<unknown> }) => input.call()),
  }))
  // Two-stage: Gemini compose runs after Jev ranking — return a non-empty
  // outfit so the happy path completes.
  vi.doMock('../../src/ai/client.js', () => geminiClientMock([
    { item_ids: ['top1', 'bot1', 'shoe1'], name: 'Composed Look', occasion: 'casual', reasoning: 'Composed from the ranked subset.' },
  ]))
  vi.doMock('../../src/ai/discoverEvents.js', () => discoverEventsMock())
  vi.doMock('../../src/storage/embeddings.js', () => embeddingsMock())
  vi.doMock('../../src/ai/embed.js', () => embedMock())
  vi.doMock('../../src/ai/embedImage.js', () => embedImageMock())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('matchClosetToContext (Discover — Jev-Noul)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('Jev-Noul happy path: ranks the shortlist, then Gemini composes outfits from the top-N ranked subset', async () => {
    const decisionsMock = vi.fn().mockResolvedValue({
      answers: {
        // Score order intentionally scrambled so the assertion tests sort.
        q_top1: { type: 'noul', noul: 0.31 },
        q_bot1: { type: 'noul', noul: 0.92 },
        q_shoe1: { type: 'noul', noul: 0.58 },
      },
      usage: { cost: 0.00015, inputTokens: 320, outputTokens: 0 },
      model: 'typesafe/jev-1.13',
      id: 'req_discover_happy',
    })

    vi.doMock('../../src/ai/decisions.js', () => ({
      generateDecisions: decisionsMock,
      JEV_MODEL: 'typesafe/jev-1.13',
    }))
    // Pass-through mock — avoids DB writes during tests.
    vi.doMock('../../src/ai/instrumented.js', () => ({
      runInstrumentedDecisions: vi.fn(async (input: { call: () => Promise<unknown> }) => input.call()),
    }))
    // Two-stage: Gemini IS invoked to compose outfits from the Jev-ranked subset.
    const geminiComposed: OutfitSuggestion[] = [
      {
        item_ids: ['bot1', 'top1', 'shoe1'],
        name: 'Muted Navy Streetwear',
        occasion: 'casual',
        reasoning: 'The navy denim anchors a clean, muted-palette look for 15°C.',
      },
      {
        item_ids: ['shoe1', 'top1'],
        name: 'Clean Canvas Minimalist',
        occasion: 'casual',
        reasoning: 'White canvas sneakers keep the minimal streetwear energy grounded.',
      },
    ]
    const geminiSpy = vi.fn().mockResolvedValue({
      data: geminiComposed,
      usage: { tokensIn: 600, tokensOut: 180 },
    })
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: geminiSpy,
      VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'gemini-2.5-flash',
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      providerForModel: () => 'gemini',
    }))
    vi.doMock('../../src/ai/discoverEvents.js', () => discoverEventsMock())
    vi.doMock('../../src/storage/embeddings.js', () => embeddingsMock())
    vi.doMock('../../src/ai/embed.js', () => embedMock())
    vi.doMock('../../src/ai/embedImage.js', () => embedImageMock())

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const { data: results, usage } = await matchClosetToContext(
      'minimalist streetwear, muted palette',
      mockItems,
      mockWeather,
      'self',
      undefined,
      'prompt',
      undefined,
    )

    // Same return shape as today's Gemini path, with prose reasoning.
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(2)
    expect(results[0]!.name).toBe('Muted Navy Streetwear')
    expect(results[0]!.reasoning).toContain('15°C')
    for (const r of results) {
      expect(Array.isArray(r.item_ids)).toBe(true)
      expect(typeof r.name).toBe('string')
      expect(typeof r.occasion).toBe('string')
      expect(typeof r.reasoning).toBe('string')
    }

    // Usage reflects the Gemini compose call (Jev cost is recorded separately
    // by runInstrumentedDecisions).
    expect(usage.tokensIn).toBe(600)
    expect(usage.tokensOut).toBe(180)

    // generateDecisions was called exactly once (single batched Jev request).
    expect(decisionsMock).toHaveBeenCalledOnce()
    // Gemini composition WAS invoked on the Jev happy path.
    expect(geminiSpy).toHaveBeenCalledOnce()

    // State carries inspiration descriptors and never leaks userId / lat / lon.
    const [state, questions] = decisionsMock.mock.calls[0]!
    const stateSerialized = JSON.stringify(state)
    expect(stateSerialized).not.toContain('user_id')
    expect(stateSerialized).not.toContain('userId')
    expect(stateSerialized).not.toContain('"self"')
    expect(stateSerialized).not.toMatch(/\blat\b/i)
    expect(stateSerialized).not.toMatch(/\blon(gitude)?\b/i)
    // No base64 image data leaks into state.
    expect(stateSerialized).not.toMatch(/base64|data:image/)

    // One Noul per shortlisted item, keyed by q_<itemId>.
    expect(Object.keys(questions).sort()).toEqual(['q_bot1', 'q_shoe1', 'q_top1'])
    for (const q of Object.values(questions)) {
      expect((q as { type: string }).type).toBe('noul')
    }

    // Gemini's compose prompt receives the Jev-ranked subset — the top-ranked
    // item (bot1, Noul 0.92) is present in the wardrobe handed to Gemini.
    const geminiPromptArg = geminiSpy.mock.calls[0]![0] as string
    expect(geminiPromptArg).toContain('bot1')
  })

  it('Gemini fallback on HTTP error: swaps to the current Gemini ranking path with the same shape', async () => {
    const httpErr = Object.assign(
      new Error('OpenRouter decisions HTTP 429: rate limited'),
      { status: 429 },
    )
    vi.doMock('../../src/ai/decisions.js', () => ({
      generateDecisions: vi.fn().mockRejectedValue(httpErr),
      JEV_MODEL: 'typesafe/jev-1.13',
    }))
    vi.doMock('../../src/ai/instrumented.js', () => ({
      runInstrumentedDecisions: vi.fn(async (input: { call: () => Promise<unknown> }) => {
        try { return await input.call() } catch (e) { throw e }
      }),
    }))
    const geminiSuggestions: OutfitSuggestion[] = [
      {
        item_ids: ['top1', 'bot1', 'shoe1'],
        name: 'Gemini Fallback Look',
        occasion: 'casual',
        reasoning: 'Muted palette matches the inspiration; layered for 15°C.',
      },
    ]
    vi.doMock('../../src/ai/client.js', () => geminiClientMock(geminiSuggestions))
    vi.doMock('../../src/ai/discoverEvents.js', () => discoverEventsMock())
    vi.doMock('../../src/storage/embeddings.js', () => embeddingsMock())
    vi.doMock('../../src/ai/embed.js', () => embedMock())
    vi.doMock('../../src/ai/embedImage.js', () => embedImageMock())

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const { data: results } = await matchClosetToContext(
      'minimalist streetwear, muted palette',
      mockItems,
      mockWeather,
      'self',
      undefined,
      'prompt',
      undefined,
    )

    // Fallback returns Gemini's suggestions verbatim, same OutfitSuggestion shape.
    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('Gemini Fallback Look')
    expect(results[0]!.item_ids).toEqual(['top1', 'bot1', 'shoe1'])
    expect(typeof results[0]!.reasoning).toBe('string')
  })

  it('cross-user isolation: distinct userIds do not share state; outbound blob has no user identifiers', async () => {
    // With 2 items per category, Jev scores change which items get ranked first.
    const answersA = {
      q_topA: { type: 'noul', noul: 0.9 }, q_topB: { type: 'noul', noul: 0.2 },
      q_botA: { type: 'noul', noul: 0.8 }, q_botB: { type: 'noul', noul: 0.3 },
      q_shoeA: { type: 'noul', noul: 0.7 }, q_shoeB: { type: 'noul', noul: 0.4 },
    }
    const answersB = {
      q_topA: { type: 'noul', noul: 0.1 }, q_topB: { type: 'noul', noul: 0.85 },
      q_botA: { type: 'noul', noul: 0.2 }, q_botB: { type: 'noul', noul: 0.95 },
      q_shoeA: { type: 'noul', noul: 0.3 }, q_shoeB: { type: 'noul', noul: 0.8 },
    }

    const decisionsMock = vi.fn()
      .mockResolvedValueOnce({
        answers: answersA,
        usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 },
        model: 'typesafe/jev-1.13', id: 'req_A',
      })
      .mockResolvedValueOnce({
        answers: answersB,
        usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 },
        model: 'typesafe/jev-1.13', id: 'req_B',
      })

    setupJevMocks(decisionsMock)

    const { matchClosetToContext } = await import('../../src/ai/discover.js')

    await matchClosetToContext(
      'minimalist streetwear', multiItems, mockWeather, 'user_A', undefined, 'prompt',
    )
    await matchClosetToContext(
      'minimalist streetwear', multiItems, mockWeather, 'user_B', undefined, 'prompt',
    )

    // Two independent Jev calls, each with its own per-user answers — proves
    // no cached state bleed at this layer.
    expect(decisionsMock).toHaveBeenCalledTimes(2)

    // Neither outbound state blob mentions either userId or `self`.
    for (const call of decisionsMock.mock.calls) {
      const [state, questions] = call
      const serialized = JSON.stringify({ state, questions })
      expect(serialized).not.toContain('user_A')
      expect(serialized).not.toContain('user_B')
      expect(serialized).not.toContain('userId')
      expect(serialized).not.toContain('user_id')
      expect(serialized).not.toContain('"self"')
    }
  })

  it('inspiration prompt passthrough: user-typed text (Prompt mode) is passed through into Jev state verbatim', async () => {
    // INTENTIONAL: freeform inspiration text is expected to reach Jev unaltered.
    // This documents the privacy-notice-flagged behaviour from #281 § "State
    // sanitization" and jev-integration-plan.md § "Phase 2". If this ever
    // starts hashing/summarising the prompt, revisit the privacy notice batch
    // under #248 before landing.
    const decisionsMock = vi.fn().mockResolvedValue({
      answers: {
        q_top1: { type: 'noul', noul: 0.5 },
        q_bot1: { type: 'noul', noul: 0.5 },
        q_shoe1: { type: 'noul', noul: 0.5 },
      },
      usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 },
      model: 'typesafe/jev-1.13', id: 'req_passthrough',
    })
    setupJevMocks(decisionsMock)

    const distinctivePrompt =
      'blokecore rugby-shirt-and-baggy-jeans energy, London winter 2005, chunky trainers'

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    await matchClosetToContext(
      distinctivePrompt,
      mockItems,
      mockWeather,
      'self',
      undefined,
      'prompt',
    )

    expect(decisionsMock).toHaveBeenCalledOnce()
    const [state] = decisionsMock.mock.calls[0]!
    const serialized = JSON.stringify(state)
    // The exact user-typed prompt appears verbatim somewhere in state.
    expect(serialized).toContain(distinctivePrompt)
  })

  it('empty shortlist: does NOT invoke generateDecisions (which throws on empty questions) — falls back cleanly', async () => {
    // Graceful-degradation: when the item set itself is empty, Jev is skipped
    // (its client rejects empty question maps) and Gemini handles the request.
    // Mirrors suggest.ts "0 saved outfits → Gemini compose".
    const decisionsMock = vi.fn().mockRejectedValue(
      new Error('generateDecisions should not be called with an empty shortlist'),
    )
    vi.doMock('../../src/ai/decisions.js', () => ({
      generateDecisions: decisionsMock,
      JEV_MODEL: 'typesafe/jev-1.13',
    }))
    vi.doMock('../../src/ai/instrumented.js', () => ({
      runInstrumentedDecisions: vi.fn(async (input: { call: () => Promise<unknown> }) => input.call()),
    }))
    const geminiFallback: OutfitSuggestion[] = [
      { item_ids: ['top1'], name: 'Empty Shortlist Look', occasion: 'casual', reasoning: 'No items matched the prefilter.' },
    ]
    vi.doMock('../../src/ai/client.js', () => geminiClientMock(geminiFallback))
    vi.doMock('../../src/ai/discoverEvents.js', () => discoverEventsMock())
    vi.doMock('../../src/storage/embeddings.js', () => embeddingsMock())
    vi.doMock('../../src/ai/embed.js', () => embedMock())
    vi.doMock('../../src/ai/embedImage.js', () => embedImageMock())

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const { data: results } = await matchClosetToContext(
      'no-match inspiration',
      [],  // empty closet → shortlisted = [] → skip Jev → Gemini fallback
      mockWeather,
      'self',
      undefined,
      'prompt',
    )

    // generateDecisions MUST NOT be called on an empty shortlist.
    expect(decisionsMock).not.toHaveBeenCalled()
    // Result comes from the Gemini fallback path; shape is preserved.
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })
})
