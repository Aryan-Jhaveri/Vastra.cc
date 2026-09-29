import { afterEach, describe, expect, it, vi } from 'vitest'

// #353 — a local/ TEXT_EMBED_MODEL / IMAGE_EMBED_MODEL routes embedText /
// embedImage to the operator's server instead of Vertex. The model ids are
// read at module load, so each case reloads the modules with fresh env.
const fetchMock = vi.fn()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

function env(model: string) {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 2048 }, (_, i) => (i % 7) - 3) }] }), { status: 200 }))
  vi.stubEnv('MOCK_EMBEDDINGS', 'false')
  vi.stubEnv('EMBED_BASE_URL', 'http://embed.test:8002/v1')
  vi.stubEnv('TEXT_EMBED_MODEL', model)
  vi.stubEnv('TEXT_EMBED_DIM', '1024')
  vi.stubEnv('IMAGE_EMBED_MODEL', model)
  vi.stubEnv('IMAGE_EMBED_DIM', '1024')
  vi.stubEnv('GCP_PROJECT_ID', '')
}

describe('local embedding routing', () => {
  it('text and image embeddings both go to the local server at the configured dimension', async () => {
    env('local/Qwen/Qwen3-VL-Embedding-2B')
    const { embedText } = await import('../../src/ai/embed.js')
    const { embedImage } = await import('../../src/ai/embedImage.js')
    const { TEXT_EMBED_MODEL_VERSION, IMAGE_EMBED_MODEL_VERSION } = await import('../../src/storage/embeddings.js')
    expect((await embedText('coat')).length).toBe(1024)
    expect((await embedImage(Buffer.from([0xff, 0xd8, 0xff]))).length).toBe(1024)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every(([u]) => u === 'http://embed.test:8002/v1/embeddings')).toBe(true)
    // One shared space: text and image rows carry the same model version.
    expect(TEXT_EMBED_MODEL_VERSION).toBe('local/Qwen/Qwen3-VL-Embedding-2B@1024')
    expect(IMAGE_EMBED_MODEL_VERSION).toBe(TEXT_EMBED_MODEL_VERSION)
  })
})
