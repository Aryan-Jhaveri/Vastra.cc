import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

vi.mock('../src/ai/aiCalls.js', () => ({ insertAiCall: vi.fn() }))

import { insertAiCall } from '../src/ai/aiCalls.js'
import { runInstrumented, isMockImageGen } from '../src/ai/instrumented.js'

// ── mock the Vertex image-gen client ─────────────────────────────────────────
vi.mock('../src/ai/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ai/client.js')>('../src/ai/client.js')
  return {
    ...actual,
    vertexAiImageGen: {
      models: {
        generateContent: vi.fn(),
      },
    },
    withRetry: vi.fn((fn: () => unknown) => fn()),
  }
})

// ── parse mocks ──────────────────────────────────────────────────────────────
vi.mock('../src/ai/parse.js', () => ({
  extractGeminiImage: vi.fn(() => ({ data: 'ZmFrZWltYWdl' })),
  parseAIJSON: vi.fn(),
}))

// ── storage mocks (avoid sharp processing fake base64 in real-mode tests) ─────
vi.mock('../src/storage/images.js', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/images.js')>('../src/storage/images.js')
  return {
    ...actual,
    saveImageFromBase64: vi.fn((_base64: string, folder: string) => {
      return Promise.resolve(`images/${folder}/mock-nanoid.jpg`)
    }),
  }
})

const DATA_DIR = process.env.CLOSET_DATA_DIR!
const heroFixture = join(__dirname, '..', 'src', 'ai', 'fixtures', 'mock-hero.jpg')
const tryonFixture = join(__dirname, '..', 'src', 'ai', 'fixtures', 'mock-tryon.jpg')

describe('isMockImageGen', () => {
  afterEach(() => {
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  it('returns false when env var is unset', () => {
    delete process.env.MOCK_AI_IMAGE_GEN
    expect(isMockImageGen()).toBe(false)
  })

  it('returns false when env var is "false"', () => {
    process.env.MOCK_AI_IMAGE_GEN = 'false'
    expect(isMockImageGen()).toBe(false)
  })

  it('returns true when env var is "true"', () => {
    process.env.MOCK_AI_IMAGE_GEN = 'true'
    expect(isMockImageGen()).toBe(true)
  })
})

describe('runInstrumented with mocked flag', () => {
  // Wallet interactions (no reservation when mocked, normal billing otherwise):
  // test/hosted/ai/mockedFlagBilling.test.ts.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets billedTokens=0 and provider="mocked" when mocked is true', async () => {
    const result = await runInstrumented({
      userId: 'self',
      task: 'tryon',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image-preview',
      expectedBilledTokens: 16,
      mocked: true,
      call: async (_ctx) => ({ result: 'mock-result' }),
    })

    expect(result).toBe('mock-result')
    expect(insertAiCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'mocked',
      billedTokens: 0,
      task: 'tryon',
      success: 1,
    }))
  })

  it('still logs ai_calls on error in mocked mode (zero cost)', async () => {
    await expect(runInstrumented({
      userId: 'self',
      task: 'tryon',
      provider: 'gemini',
      model: 'gemini-3.1-flash-image-preview',
      expectedBilledTokens: 16,
      mocked: true,
      call: async (_ctx) => { throw new Error('Boom') },
    })).rejects.toThrow('Boom')

    expect(insertAiCall).toHaveBeenCalledWith(expect.objectContaining({
      success: 0,
      provider: 'mocked',
      billedTokens: 0,
    }))
  })
})

describe('generateHeroImage mock mode', () => {
  const userId = 'self'
  const itemsDir = join(DATA_DIR, 'users', userId, 'images', 'items')

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MOCK_AI_IMAGE_GEN = 'true'
    if (existsSync(itemsDir)) rmSync(itemsDir, { recursive: true })
    mkdirSync(itemsDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env.MOCK_AI_IMAGE_GEN
    if (existsSync(itemsDir)) rmSync(itemsDir, { recursive: true })
  })

  it('copies the fixture and returns a valid path in mock mode', async () => {
    const { generateHeroImage } = await import('../src/ai/heroImage.js')

    const result = await generateHeroImage(['ZmFrZQ=='], userId)
    expect(result).toMatch(/^images\/items\/.+\.jpg$/)
    expect(existsSync(join(DATA_DIR, 'users', userId, result))).toBe(true)
  })

  it('logs [MOCK] heroImage in mock mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { generateHeroImage } = await import('../src/ai/heroImage.js')

    await generateHeroImage(['ZmFrZQ=='], userId)
    expect(logSpy).toHaveBeenCalledWith('[MOCK] heroImage')
    logSpy.mockRestore()
  })

  it('throws if no images provided even in mock mode', async () => {
    const { generateHeroImage } = await import('../src/ai/heroImage.js')

    await expect(generateHeroImage([], userId)).rejects.toThrow('At least one reference image is required')
  })
})

describe('generateHeroImage real mode', () => {
  const userId = 'self'

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  afterEach(() => {
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  it('calls Vertex image-gen when not in mock mode', async () => {
    const { vertexAiImageGen, withRetry } = await import('../src/ai/client.js')
    vi.mocked(vertexAiImageGen.models.generateContent).mockResolvedValue({})

    const { generateHeroImage } = await import('../src/ai/heroImage.js')

    await generateHeroImage(['ZmFrZQ=='], userId)
    expect(withRetry).toHaveBeenCalled()
    expect(vertexAiImageGen.models.generateContent).toHaveBeenCalled()
  })
})

describe('generateTryOn mock mode', () => {
  const userId = 'self'
  const tryonDir = join(DATA_DIR, 'users', userId, 'images', 'tryon')

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MOCK_AI_IMAGE_GEN = 'true'
    if (existsSync(tryonDir)) rmSync(tryonDir, { recursive: true })
    mkdirSync(tryonDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env.MOCK_AI_IMAGE_GEN
    if (existsSync(tryonDir)) rmSync(tryonDir, { recursive: true })
  })

  it('copies the fixture and returns a valid path in mock mode', async () => {
    const { generateTryOn } = await import('../src/ai/tryon.js')

    const result = await generateTryOn('ZmFrZQ==', ['ZmFrZQ=='], userId)
    expect(result).toMatch(/^images\/tryon\/.+\.jpg$/)
    expect(existsSync(join(DATA_DIR, 'users', userId, result))).toBe(true)
  })

  it('logs [MOCK] tryon in mock mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { generateTryOn } = await import('../src/ai/tryon.js')

    await generateTryOn('ZmFrZQ==', ['ZmFrZQ=='], userId)
    expect(logSpy).toHaveBeenCalledWith('[MOCK] tryon')
    logSpy.mockRestore()
  })
})

describe('generateTryOn real mode', () => {
  const userId = 'self'

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  afterEach(() => {
    delete process.env.MOCK_AI_IMAGE_GEN
  })

  it('calls Vertex image-gen when not in mock mode', async () => {
    const { vertexAiImageGen, withRetry } = await import('../src/ai/client.js')
    vi.mocked(vertexAiImageGen.models.generateContent).mockResolvedValue({})

    const { generateTryOn } = await import('../src/ai/tryon.js')

    await generateTryOn('ZmFrZQ==', ['ZmFrZQ=='], userId)
    expect(withRetry).toHaveBeenCalled()
    expect(vertexAiImageGen.models.generateContent).toHaveBeenCalled()
  })
})
