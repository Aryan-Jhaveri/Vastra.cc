import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseAIJSON, extractGeminiImage } from '../../src/ai/parse.js'

// ─── parseAIJSON ──────────────────────────────────────────────────────────

describe('parseAIJSON', () => {
  it('parses bare JSON object', () => {
    const result = parseAIJSON<{ category: string }>('{"category":"tops"}')
    expect(result.category).toBe('tops')
  })

  it('strips ```json fences', () => {
    const result = parseAIJSON<{ category: string }>(
      '```json\n{"category":"shoes"}\n```'
    )
    expect(result.category).toBe('shoes')
  })

  it('strips plain ``` fences', () => {
    const result = parseAIJSON<{ value: number }>('```\n{"value":42}\n```')
    expect(result.value).toBe(42)
  })

  it('parses a JSON array', () => {
    const result = parseAIJSON<{ id: string }[]>(
      '```json\n[{"id":"a"},{"id":"b"}]\n```'
    )
    expect(result).toHaveLength(2)
    expect(result[1].id).toBe('b')
  })

  it('falls back to regex extraction when there is surrounding text', () => {
    const result = parseAIJSON<{ ok: boolean }>(
      'Here is your JSON: {"ok":true} hope that helps!'
    )
    expect(result.ok).toBe(true)
  })

  it('throws on truly malformed input', () => {
    expect(() => parseAIJSON('not json at all')).toThrow()
  })

  it('throws on null/empty input', () => {
    expect(() => parseAIJSON(null)).toThrow()
    expect(() => parseAIJSON('')).toThrow()
  })
})

// ─── extractGeminiImage ───────────────────────────────────────────────────────

describe('extractGeminiImage', () => {
  it('extracts base64 image from a valid response', () => {
    const response = {
      candidates: [{
        content: {
          parts: [
            { inlineData: { data: 'abc123base64', mimeType: 'image/jpeg' } },
          ],
        },
      }],
    }
    const result = extractGeminiImage(response)
    expect(result.data).toBe('abc123base64')
    expect(result.mimeType).toBe('image/jpeg')
  })

  it('defaults mimeType to image/png when missing', () => {
    const response = {
      candidates: [{
        content: { parts: [{ inlineData: { data: 'xyz' } }] },
      }],
    }
    const result = extractGeminiImage(response)
    expect(result.mimeType).toBe('image/png')
  })

  it('throws when no candidates', () => {
    expect(() => extractGeminiImage({ candidates: [] })).toThrow()
  })

  it('throws when parts contain no image', () => {
    const response = {
      candidates: [{ content: { parts: [{ text: 'just text' }] } }],
    }
    expect(() => extractGeminiImage(response)).toThrow('No image data')
  })
})

// ─── categorizeItem (mocked) ──────────────────────────────────────────────────

describe('categorizeItem', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('parses a valid categorization response', async () => {
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: {
          category: 'tops',
          subcategory: 't-shirt',
          primary_color: 'black',
          colors: ['black'],
          material: '100% Cotton',
          season: ['spring', 'summer'],
          ai_description: 'A slim black cotton t-shirt.',
          suggested_tags: ['casual', 'basics'],
        },
        usage: { tokensIn: 100, tokensOut: 50 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
    }))

    const { categorizeItem } = await import('../../src/ai/categorize.js')
    const { data: result } = await categorizeItem('fakebase64')
    expect(result.category).toBe('tops')
    expect(result.primary_color).toBe('black')
    expect(result.suggested_tags).toContain('casual')
  })

  it('handles markdown-wrapped JSON from AI', async () => {
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: {
          category: 'shoes',
          subcategory: 'sneakers',
          primary_color: 'white',
          colors: ['white'],
          material: 'leather',
          season: ['spring', 'summer', 'fall'],
          ai_description: 'White leather sneakers.',
          suggested_tags: ['casual'],
        },
        usage: { tokensIn: 120, tokensOut: 40 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
    }))

    const { categorizeItem } = await import('../../src/ai/categorize.js')
    const { data: result } = await categorizeItem('fakebase64')
    expect(result.category).toBe('shoes')
    expect(result.subcategory).toBe('sneakers')
  })
})

// ─── scanTag (mocked) ─────────────────────────────────────────────────────────

describe('scanTag', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('parses a valid tag scan response', async () => {
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: {
          brand: 'Patagonia',
          size: 'M',
          material_composition: '100% Recycled Polyester',
          care_instructions: ['Machine wash cold', 'Hang dry'],
          country_of_origin: 'Vietnam',
        },
        usage: { tokensIn: 80, tokensOut: 30 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
    }))

    const { scanTag } = await import('../../src/ai/scanTag.js')
    const { data: result } = await scanTag('fakebase64')
    expect(result.brand).toBe('Patagonia')
    expect(result.care_instructions).toContain('Hang dry')
  })
})
