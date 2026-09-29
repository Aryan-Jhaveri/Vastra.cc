import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/ai/client.js', () => ({
  generateJSONWithUsage: vi.fn(),
  VISION_MODEL: 'gemini-2.0-flash',
}))

import { analyzeInspiration, type InspirationContext } from '../../src/ai/inspiration.js'
import * as clientMod from '../../src/ai/client.js'
import { COLORS } from '../../src/constants/colors.js'

const fullContext: InspirationContext = {
  description: 'Baggy yellow streetwear, oversized cropped boxy silhouette in heavyweight cotton',
  dominantColors: ['mustard', 'black'],
  vibe: 'bold streetwear',
  garmentHints: ['oversized hoodie', 'cargo pants'],
  materials: ['cotton', 'ripstop'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(clientMod.generateJSONWithUsage).mockResolvedValue({
    data: fullContext,
    usage: { tokensIn: 200, tokensOut: 100 },
  })
})

describe('analyzeInspiration (#283 — descriptor quality)', () => {
  it('constrains dominantColors to the canonical COLORS vocabulary items use', async () => {
    await analyzeInspiration('base64img')
    const prompt = vi.mocked(clientMod.generateJSONWithUsage).mock.calls[0]![0] as string

    expect(prompt).toContain('"dominantColors"')
    expect(prompt).toContain(COLORS.join(', '))
    expect(prompt).not.toContain('#RRGGBB')
  })

  it('demands silhouette and material words in the description', async () => {
    await analyzeInspiration('base64img')
    const prompt = vi.mocked(clientMod.generateJSONWithUsage).mock.calls[0]![0] as string

    expect(prompt).toMatch(/silhouette/i)
    expect(prompt).toMatch(/material/i)
    expect(prompt).toMatch(/at least one silhouette word and one material word/i)
  })

  it('returns the parsed context including the materials field', async () => {
    const { data } = await analyzeInspiration('base64img')

    expect(data.dominantColors).toEqual(['mustard', 'black'])
    expect(data.materials).toEqual(['cotton', 'ripstop'])
    expect(data.garmentHints).toHaveLength(2)
    expect(data.description).toContain('oversized')
  })

  it('passes dominantColors through untouched (they feed downstream embedding/Jev text)', async () => {
    vi.mocked(clientMod.generateJSONWithUsage).mockResolvedValue({
      data: { ...fullContext, dominantColors: ['white'] },
      usage: { tokensIn: 10, tokensOut: 10 },
    })

    const { data } = await analyzeInspiration('base64img')
    expect(data.dominantColors).toEqual(['white'])
  })
})