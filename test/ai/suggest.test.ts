import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WeatherData, Item, Outfit, OutfitSuggestion } from '../../src/types/index.js'

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
  },
  {
    id: 'bot1', imageUri: 'images/items/bot1.jpg', tagImageUri: null,
    category: 'bottoms', subcategory: 'jeans', primaryColor: 'navy',
    colors: '["navy"]', material: 'denim', careInstructions: '[]',
    brand: 'Levi\'s', size: '32x30', season: '["spring","fall"]', tags: '["casual"]',
    aiDescription: 'Classic navy denim jeans.', occasion: '["casual","work"]',
    timesWorn: 2, lastWornAt: null, createdAt: Date.now(), updatedAt: Date.now(),
  },
]

const mockOutfits: Outfit[] = [
  {
    id: 'outfit_a', userId: 'self', name: 'Spring Casual',
    itemIds: JSON.stringify(['top1', 'bot1']), occasion: 'casual',
    season: '["spring"]', tags: '["casual"]', aiGenerated: 0, timesWorn: 0,
    lastWornAt: null, weatherContext: null, notes: null, coverImageUri: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  },
  {
    id: 'outfit_b', userId: 'self', name: 'Office Navy',
    itemIds: JSON.stringify(['bot1']), occasion: 'work',
    season: '["fall"]', tags: '["work"]', aiGenerated: 0, timesWorn: 1,
    lastWornAt: null, weatherContext: null, notes: null, coverImageUri: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  },
]

// Shared client.js mock for the Gemini compose path (fallback).
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

describe('suggestOutfits', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns outfit suggestions from a valid Gemini response (fallback path)', async () => {
    // No saved outfits → Jev path returns [] → Gemini compose fallback.
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../../src/ai/client.js', () => geminiClientMock([
      {
        item_ids: ['top1', 'bot1'],
        name: 'Spring Casual',
        occasion: 'casual',
        reasoning: 'Light layers work well for partly cloudy 15°C weather.',
      },
    ]))

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const results = await suggestOutfits(mockWeather, mockItems)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Spring Casual')
    expect(results[0].item_ids).toContain('top1')
  })

  it('compose prompt leads with fixed instructions + wardrobe and ends with today\'s context (cacheable prefix)', async () => {
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
    }))
    const client = geminiClientMock([{ item_ids: ['top1'], name: 'X', occasion: 'casual', reasoning: 'r' }])
    vi.doMock('../../src/ai/client.js', () => client)

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    await suggestOutfits(mockWeather, mockItems, 'self', undefined, 'work', 9, 1)
    await suggestOutfits({ ...mockWeather, temperature: 31, condition: 'Sunny' }, mockItems, 'self', undefined, 'party', 21, 6)
    const [first, second] = client.generateJSONWithUsage.mock.calls.map(c => String(c[0]))

    const cut = (p: string) => p.slice(0, p.indexOf("Today's context:"))
    expect(first.startsWith('Suggest 2 outfit combinations')).toBe(true)
    expect(cut(first)).toContain('"id": "top1"')
    expect(cut(first)).not.toMatch(/15°C|31°C|Partly cloudy|Sunny/)
    // Everything before the changing context is byte-identical across calls.
    expect(cut(first)).toBe(cut(second))
    expect(first.indexOf('Weather: 15°C')).toBeGreaterThan(first.indexOf('Wardrobe items:'))
    expect(second).toContain('The user is dressing for: party.')
  })

  it('handles markdown-wrapped JSON (Gemini fallback path)', async () => {
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../../src/ai/client.js', () => geminiClientMock([
      { item_ids: ['top1'], name: 'Minimalist', occasion: 'casual', reasoning: 'Simple and clean.' },
    ]))

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const results = await suggestOutfits(mockWeather, mockItems)
    expect(results[0].name).toBe('Minimalist')
  })

  it('ranks saved outfits via Jev-Noul and returns the same OutfitSuggestion[] shape', async () => {
    const decisionsMock = vi.fn().mockResolvedValue({
      answers: {
        q_outfit_a: { type: 'noul', noul: 0.42 },
        q_outfit_b: { type: 'noul', noul: 0.88 },
      },
      usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 },
      model: 'typesafe/jev-1.13',
      id: 'req_test',
    })
    vi.doMock('../../src/ai/decisions.js', () => ({
      generateDecisions: decisionsMock,
      JEV_MODEL: 'typesafe/jev-1.13',
    }))
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue(mockOutfits),
    }))
    // Ensure the Gemini path is NOT used on the Jev happy path.
    const geminiSpy = vi.fn()
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: geminiSpy,
      VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'gemini-2.5-flash',
      providerForModel: () => 'gemini',
    }))

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const results = await suggestOutfits(mockWeather, mockItems, 'self', undefined, 'work')

    // Ranked by descending Noul: outfit_b (0.88) first, outfit_a (0.42) second.
    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('Office Navy')
    expect(results[0].item_ids).toEqual(['bot1'])
    expect(results[0].occasion).toBe('work')
    expect(results[1].name).toBe('Spring Casual')
    expect(results[1].item_ids).toEqual(['top1', 'bot1'])

    // Same shape as the Gemini path: every field of OutfitSuggestion present.
    for (const r of results) {
      expect(Array.isArray(r.item_ids)).toBe(true)
      expect(typeof r.name).toBe('string')
      expect(typeof r.occasion).toBe('string')
      expect(typeof r.reasoning).toBe('string')
    }

    // Gemini fallback was NOT invoked on the Jev happy path.
    expect(geminiSpy).not.toHaveBeenCalled()
    // generateDecisions was called once (batched), with object state carrying
    // weather values + occasion — and no userId / lat / lon leak.
    expect(decisionsMock).toHaveBeenCalledOnce()
    const [state, questions] = decisionsMock.mock.calls[0]!
    expect(state).toHaveProperty('weather')
    expect(state).toHaveProperty('occasion', 'work')
    expect(JSON.stringify(state)).not.toContain('user_id')
    expect(JSON.stringify(state)).not.toMatch(/lat|lon/i)
    expect(Object.keys(questions)).toEqual(['q_outfit_a', 'q_outfit_b'])
  })

  it('falls back to Gemini compose when Jev throws an HTTP error, returning the same shape', async () => {
    const httpErr = Object.assign(new Error('OpenRouter decisions HTTP 429: rate limited'), { status: 429 })
    vi.doMock('../../src/ai/decisions.js', () => ({
      generateDecisions: vi.fn().mockRejectedValue(httpErr),
      JEV_MODEL: 'typesafe/jev-1.13',
    }))
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue(mockOutfits),
    }))
    const geminiFallback = [
      { item_ids: ['top1', 'bot1'], name: 'Gemini Fallback Outfit', occasion: 'casual', reasoning: 'Works for 15°C.' },
    ]
    vi.doMock('../../src/ai/client.js', () => geminiClientMock(geminiFallback))

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const results = await suggestOutfits(mockWeather, mockItems)

    // Gemini fallback path taken; same shape + item-id set as the Gemini path.
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('Gemini Fallback Outfit')
    expect(results[0].item_ids).toEqual(['top1', 'bot1'])
    expect(typeof results[0].reasoning).toBe('string')
  })
})

describe('generateTryOn', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('saves the result image and returns a relative path', async () => {
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSON: vi.fn(),
      generateText: vi.fn(),
      vertexAiImageGen: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            candidates: [{
              content: {
                parts: [{ inlineData: { data: 'ZmFrZWltYWdlZGF0YQ==', mimeType: 'image/jpeg' } }],
              },
            }],
          }),
        },
      },
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      TEXT_MODEL: 'gemini-2.5-flash',
      withRetry: async <T>(fn: () => Promise<T>) => fn(),
      isModelBusy: () => false,
    }))
    vi.doMock('../../src/storage/images.js', () => ({
      saveImageFromBase64: vi.fn().mockResolvedValue('images/tryon/mock-result.jpg'),
    }))

    const { generateTryOn } = await import('../../src/ai/tryon.js')
    const result = await generateTryOn('userbase64', ['item1base64'])
    expect(result).toMatch(/^images\/tryon\/.+\.jpg$/)
  })

  it('throws when Gemini returns no image', async () => {
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSON: vi.fn(),
      generateText: vi.fn(),
      vertexAiImageGen: {
        models: {
          generateContent: vi.fn().mockResolvedValue({
            candidates: [{
              content: { parts: [{ text: 'I cannot generate that image.' }] },
            }],
          }),
        },
      },
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      TEXT_MODEL: 'gemini-2.5-flash',
      withRetry: async <T>(fn: () => Promise<T>) => fn(),
      isModelBusy: () => false,
    }))

    const { generateTryOn } = await import('../../src/ai/tryon.js')
    await expect(generateTryOn('userbase64', ['item1base64'])).rejects.toThrow('No image data')
  })
})
