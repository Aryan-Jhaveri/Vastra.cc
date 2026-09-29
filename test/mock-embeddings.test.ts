import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'

// ── mock Vertex client ────────────────────────────────────────────────────────
vi.mock('../src/ai/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/ai/client.js')>('../src/ai/client.js')
  return {
    ...actual,
    vertexAi: {
      models: {
        embedContent: vi.fn(),
      },
    },
  }
})

// embedImage no longer uses vertexAi — it calls Vertex predict via fetch + ADC.
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function () {
    this.getAccessToken = vi.fn().mockResolvedValue('test-access-token')
  }),
  OAuth2Client: vi.fn(),
}))

import { vertexAi } from '../src/ai/client.js'
import {
  isMockEmbeddings,
  mockEmbeddingVector,
  TEXT_EMBED_DIM,
  IMAGE_EMBED_DIM,
} from '../src/storage/embeddings.js'

describe('isMockEmbeddings', () => {
  afterEach(() => {
    delete process.env.MOCK_EMBEDDINGS
  })

  it('returns false when env var is unset', () => {
    delete process.env.MOCK_EMBEDDINGS
    expect(isMockEmbeddings()).toBe(false)
  })

  it('returns false when env var is "false"', () => {
    process.env.MOCK_EMBEDDINGS = 'false'
    expect(isMockEmbeddings()).toBe(false)
  })

  it('returns true when env var is "true"', () => {
    process.env.MOCK_EMBEDDINGS = 'true'
    expect(isMockEmbeddings()).toBe(true)
  })
})

describe('mockEmbeddingVector', () => {
  it('returns a Float32Array of the requested dimension', () => {
    const vec = mockEmbeddingVector('hello', 1024)
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(1024)
  })

  it('is deterministic (same input → same vector)', () => {
    const a = mockEmbeddingVector('hello', 1024)
    const b = mockEmbeddingVector('hello', 1024)
    expect(a).toEqual(b)
  })

  it('produces different vectors for different inputs', () => {
    const a = mockEmbeddingVector('hello', 1024)
    const b = mockEmbeddingVector('world', 1024)
    // At least one element should differ
    const matches = Array.from(a).filter((v, i) => v === b[i]).length
    expect(matches).toBeLessThan(a.length)
  })

  it('works with Buffer input', () => {
    const vec = mockEmbeddingVector(Buffer.from('test'), 1024)
    expect(vec.length).toBe(1024)
  })

  it('produces valid image-dimension vectors (1408)', () => {
    const vec = mockEmbeddingVector('image-test', IMAGE_EMBED_DIM)
    expect(vec.length).toBe(IMAGE_EMBED_DIM)
  })

  it('produces L2-normalised vectors (norm ≈ 1)', () => {
    const vec = mockEmbeddingVector('norm-test', 1024)
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    expect(Math.abs(norm - 1)).toBeLessThan(0.0001)
  })
})

describe('embedText mock mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MOCK_EMBEDDINGS = 'true'
  })

  afterEach(() => {
    delete process.env.MOCK_EMBEDDINGS
  })

  it('returns deterministic vector without calling Vertex', async () => {
    const { embedText } = await import('../src/ai/embed.js')

    const vec = await embedText('a test item description')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(TEXT_EMBED_DIM)
    expect(vertexAi.models.embedContent).not.toHaveBeenCalled()
  })

  it('logs [MOCK] embedText', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { embedText } = await import('../src/ai/embed.js')

    await embedText('test')
    expect(logSpy).toHaveBeenCalledWith('[MOCK] embedText')
    logSpy.mockRestore()
  })
})

describe('embedText real mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MOCK_EMBEDDINGS
  })

  afterEach(() => {
    delete process.env.MOCK_EMBEDDINGS
  })

  it('calls Vertex when not in mock mode', async () => {
    vi.mocked(vertexAi.models.embedContent).mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    })

    const { embedText } = await import('../src/ai/embed.js')
    await embedText('test')

    expect(vertexAi.models.embedContent).toHaveBeenCalled()
  })
})

describe('embedImage mock mode', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MOCK_EMBEDDINGS = 'true'
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    delete process.env.MOCK_EMBEDDINGS
    vi.unstubAllGlobals()
  })

  it('returns deterministic vector without calling Vertex', async () => {
    const { embedImage } = await import('../src/ai/embedImage.js')

    const vec = await embedImage(Buffer.from('fake image data'))
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(IMAGE_EMBED_DIM)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('logs [MOCK] embedImage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { embedImage } = await import('../src/ai/embedImage.js')

    await embedImage(Buffer.from('test'))
    expect(logSpy).toHaveBeenCalledWith('[MOCK] embedImage')
    logSpy.mockRestore()
  })
})

describe('embedImage real mode', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MOCK_EMBEDDINGS
    process.env.GCP_PROJECT_ID = 'test-project'
    process.env.GCP_LOCATION = 'us-central1'
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    delete process.env.MOCK_EMBEDDINGS
    vi.unstubAllGlobals()
  })

  it('calls Vertex predict endpoint when not in mock mode', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ predictions: [{ imageEmbedding: [0.1, 0.2, 0.3] }] }),
      text: async () => '',
    })

    const { embedImage } = await import('../src/ai/embedImage.js')
    await embedImage(Buffer.from('test'))

    expect(mockFetch).toHaveBeenCalled()
    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('multimodalembedding@001:predict')
  })
})
