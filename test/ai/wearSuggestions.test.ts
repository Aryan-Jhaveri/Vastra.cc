import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// #312 — refine chips are scoped to one selected garment, never add garments,
// use the item images when the model can take them, and know the outfit.

const generateJSONWithUsage = vi.fn()
vi.mock('../../src/ai/client.js', () => ({
  vertexAiImageGen: { models: { generateContent: vi.fn() } },
  IMAGE_GEN_MODEL: 'gemini-2.5-flash-image',
  withRetry: (fn: () => unknown) => fn(),
  isModelBusy: () => false,
  generateJSONWithUsage: (...args: unknown[]) => generateJSONWithUsage(...args),
}))
vi.mock('../../src/storage/images.js', () => ({
  saveImageFromBase64: vi.fn(),
  getUserImagesDir: vi.fn(),
}))

import { buildWearSuggestionsPrompt, generateWearSuggestions, normalizeWearSuggestions } from '../../src/ai/tryon.js'

const coat = { context: 'outerwear / trench coat — A beige trench with a belt' }
const tee = { context: 'tops / t-shirt — A white cotton tee' }
const usage = { tokensIn: 5, tokensOut: 5 }

beforeEach(() => {
  generateJSONWithUsage.mockReset()
  delete process.env.TEXT_MODEL
})
afterEach(() => { delete process.env.TEXT_MODEL })

describe('buildWearSuggestionsPrompt', () => {
  it('numbers the garments, forbids adding any, and asks for the garment number', () => {
    const p = buildWearSuggestionsPrompt([coat, tee])
    expect(p).toContain('1. outerwear / trench coat')
    expect(p).toContain('2. tops / t-shirt')
    expect(p).toMatch(/Never add, suggest or mention a garment, accessory or item that is not in the list/)
    expect(p).toContain('"item": the garment number')
    expect(p).not.toContain('saved outfit')
    expect(p).not.toContain('The images are the garments')
  })

  it("includes the outfit's name, occasion and season when given", () => {
    const p = buildWearSuggestionsPrompt([coat], { name: 'Rainy commute', occasion: 'work', season: ['fall', 'spring'] })
    expect(p).toContain('the saved outfit "Rainy commute", worn for work, in fall/spring.')
  })

  it('tells the model the images follow the list order when every garment has one', () => {
    const p = buildWearSuggestionsPrompt([{ ...coat, imageBase64: 'a' }, { ...tee, imageBase64: 'b' }])
    expect(p).toContain('image 1 is garment 1')
  })
})

describe('normalizeWearSuggestions', () => {
  it('keeps chips that name a listed garment and drops out-of-range, missing or malformed ones', () => {
    const raw = [
      { item: 1, label: 'Belted', instruction: 'Belt the trench closed.' },
      { item: 2, label: ' Tucked ', instruction: 'Tuck the tee in.' },
      { item: 3, label: 'Turtleneck', instruction: 'Add a turtleneck.' },
      { item: 0, label: 'Zero', instruction: 'x' },
      { item: 1.5, label: 'Half', instruction: 'x' },
      { label: 'No item', instruction: 'x' },
      { item: 1, label: '', instruction: 'x' },
      'Roll the sleeves',
    ]
    expect(normalizeWearSuggestions(raw, 2)).toEqual([
      { label: 'Belted', instruction: 'Belt the trench closed.', itemIndex: 0 },
      { label: 'Tucked', instruction: 'Tuck the tee in.', itemIndex: 1 },
    ])
    expect(normalizeWearSuggestions({ not: 'an array' }, 2)).toEqual([])
  })

  it('caps the number of chips at 6', () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({ item: 1, label: `L${i}`, instruction: `I${i}` }))
    expect(normalizeWearSuggestions(raw, 1)).toHaveLength(6)
  })
})

describe('generateWearSuggestions', () => {
  it('sends the garment images with the prompt, in order, when every garment has one', async () => {
    generateJSONWithUsage.mockResolvedValue({ data: [{ item: 2, label: 'Tucked', instruction: 'Tuck the tee in.' }], usage })
    const out = await generateWearSuggestions([{ ...coat, imageBase64: 'coat-b64' }, { ...tee, imageBase64: 'tee-b64' }])
    const [prompt, images, model] = generateJSONWithUsage.mock.calls[0]
    expect(images).toEqual(['coat-b64', 'tee-b64'])
    expect(model).toBe('gemini-2.5-flash')
    expect(prompt).toContain('image 1 is garment 1')
    expect(out).toEqual({ data: [{ label: 'Tucked', instruction: 'Tuck the tee in.', itemIndex: 1 }], usage })
  })

  it('sends no images when any garment lacks one', async () => {
    generateJSONWithUsage.mockResolvedValue({ data: [], usage })
    await generateWearSuggestions([{ ...coat, imageBase64: 'coat-b64' }, tee])
    expect(generateJSONWithUsage.mock.calls[0][1]).toBeUndefined()
  })

  it('a model failure returns no chips instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    generateJSONWithUsage.mockRejectedValue(new Error('boom'))
    await expect(generateWearSuggestions([coat])).resolves.toEqual({ data: [], usage: { tokensIn: 0, tokensOut: 0 } })
    err.mockRestore()
  })

  it('makes no model call for no garments', async () => {
    await generateWearSuggestions([])
    expect(generateJSONWithUsage).not.toHaveBeenCalled()
  })
})
