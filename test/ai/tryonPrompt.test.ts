import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateContent = vi.fn()
vi.mock('../../src/ai/client.js', () => ({
  vertexAiImageGen: { models: { generateContent: (...args: unknown[]) => generateContent(...args) } },
  IMAGE_GEN_MODEL: 'gemini-2.5-flash-image',
  withRetry: (fn: () => unknown) => fn(),
  isModelBusy: () => false,
  generateJSONWithUsage: vi.fn(),
}))
vi.mock('../../src/ai/parse.js', () => ({
  extractGeminiImage: () => ({ data: 'result-b64' }),
  parseAIJSON: vi.fn(),
}))
vi.mock('../../src/storage/images.js', () => ({
  saveImageFromBase64: vi.fn(async () => 'images/tryon/out.jpg'),
  getUserImagesDir: vi.fn(),
}))

import { buildPrompt, generateTryOn } from '../../src/ai/tryon.js'

describe('try-on prompt', () => {
  it('names the LAST image as the only person to edit and locks the body, not just the face', () => {
    const p = buildPrompt(3)
    expect(p).toContain('Images 1–3 are CLOTHING')
    expect(p).toContain('Image 4 (the LAST image) is the PERSON')
    expect(p).not.toContain('Image 1 is the PERSON')
    expect(p).toMatch(/body_lock/)
    expect(p).toMatch(/DO NOT use, copy or blend in any person/)
  })

  it('numbers garment context against clothing images when the counts match, and prefers the image', () => {
    const p = buildPrompt(2, ['top / oxford shirt', 'bottom / trousers'])
    expect(p).toContain('Image 1: top / oxford shirt')
    expect(p).toContain('Image 2: bottom / trousers')
    expect(p).toContain('Image 3 (the LAST image) is the PERSON')
    expect(p).toContain('follow the IMAGE')
  })

  it('lists context unnumbered when counts differ (multi-view or ad-hoc uploads)', () => {
    const p = buildPrompt(3, ['top / oxford shirt'])
    expect(p).not.toContain('Image 1: top')
    expect(p).toContain('- top / oxford shirt')
  })

  it('uses the singular form for one clothing image', () => {
    const p = buildPrompt(1)
    expect(p).toContain('Image 1 is a CLOTHING item')
    expect(p).toContain('Image 2 (the LAST image) is the PERSON')
  })
})

describe('generateTryOn request', () => {
  beforeEach(() => {
    generateContent.mockReset().mockResolvedValue({})
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  // Gemini edits the final image (output takes its aspect ratio). With the
  // person first, prod outputs matched the last garment's shape and showed an
  // invented model instead of the user.
  it('sends each clothing image first, then the person photo LAST, then the prompt', async () => {
    await generateTryOn('person-b64', ['shirt-b64', 'pants-b64'], 'u1', ['top / shirt', 'bottom / pants'])
    const parts = generateContent.mock.calls[0]![0].contents[0].parts
    expect(parts.map((p: { inlineData?: { data: string } }) => p.inlineData?.data)).toEqual(['shirt-b64', 'pants-b64', 'person-b64', undefined])
    expect(parts[3].text).toContain('Images 1–2 are CLOTHING')
    expect(parts[3].text).toContain('Image 3 (the LAST image) is the PERSON')
    expect(parts[3].text).toContain('Image 1: top / shirt')
  })

  it('pins the output to the square-padded person canvas, not a garment photo shape', async () => {
    await generateTryOn('person-b64', ['wide-shorts-b64'], 'u1')
    const { config } = generateContent.mock.calls[0]![0]
    expect(config.imageConfig).toEqual({ aspectRatio: '1:1' })
    expect(config.responseModalities).toEqual(['IMAGE', 'TEXT'])
  })
})
