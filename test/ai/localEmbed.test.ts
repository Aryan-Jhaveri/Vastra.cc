import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetModelServerSlots } from '../../src/ai/modelServers.js'
import { DEFAULT_EMBED_INSTRUCTION, localEmbedImage, localEmbedText } from '../../src/ai/localEmbed.js'

// #353 — Qwen3-VL-Embedding on vLLM (`--runner pooling`) via /v1/embeddings.
const fetchMock = vi.fn()
const MODEL = 'local/Qwen/Qwen3-VL-Embedding-2B'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const embedding = (values: number[], tokens = 9) => json({ object: 'list', data: [{ index: 0, object: 'embedding', embedding: values }], usage: { prompt_tokens: tokens } })
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(String(init.body)) }
}

beforeEach(() => {
  __resetModelServerSlots()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('EMBED_BASE_URL', 'http://embed.test:8002/v1')
  vi.stubEnv('EMBED_API_KEY', 'embed-key')
  vi.stubEnv('EMBED_REQUEST', '')
  vi.stubEnv('EMBED_INSTRUCTION', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('localEmbedText', () => {
  it('sends chat messages with the instruction to EMBED_BASE_URL/embeddings, model prefix stripped', async () => {
    fetchMock.mockResolvedValueOnce(embedding([3, 4, 12]))
    const out = await localEmbedText('navy wool coat', MODEL, 3)
    const { url, init, body } = sent()
    expect(url).toBe('http://embed.test:8002/v1/embeddings')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer embed-key')
    expect(body).toEqual({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      encoding_format: 'float',
      messages: [
        { role: 'system', content: [{ type: 'text', text: DEFAULT_EMBED_INSTRUCTION }] },
        { role: 'user', content: [{ type: 'text', text: 'navy wool coat' }] },
      ],
    })
    expect(out.tokens).toBe(9)
    expect(Array.from(out.vector).map(v => +v.toFixed(4))).toEqual([0.2308, 0.3077, 0.9231])
  })

  it('truncates a Matryoshka vector to the configured dimension and re-normalises it', async () => {
    fetchMock.mockResolvedValueOnce(embedding([3, 4, 100, 100]))
    const out = await localEmbedText('x', MODEL, 2)
    expect(Array.from(out.vector).map(v => +v.toFixed(4))).toEqual([0.6, 0.8])
  })

  it('refuses a vector shorter than the configured dimension', async () => {
    fetchMock.mockResolvedValueOnce(embedding([1, 2]))
    await expect(localEmbedText('x', MODEL, 1024)).rejects.toThrow(/2 dimensions; the configured dimension is 1024/)
  })

  it('refuses a malformed response', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ embedding: ['a'] }] }))
    await expect(localEmbedText('x', MODEL, 1)).rejects.toThrow(/no embedding/)
  })

  it('EMBED_REQUEST=input sends the plain OpenAI form for text-only servers', async () => {
    vi.stubEnv('EMBED_REQUEST', 'input')
    fetchMock.mockResolvedValueOnce(embedding([1, 0]))
    await localEmbedText('hello', MODEL, 2)
    expect(sent().body).toEqual({ model: 'Qwen/Qwen3-VL-Embedding-2B', encoding_format: 'float', input: 'hello' })
  })

  it('EMBED_INSTRUCTION overrides the instruction', async () => {
    vi.stubEnv('EMBED_INSTRUCTION', 'Represent this garment.')
    fetchMock.mockResolvedValueOnce(embedding([1, 0]))
    await localEmbedText('x', MODEL, 2)
    expect(sent().body.messages[0].content[0].text).toBe('Represent this garment.')
  })

  it('falls back to the chat server when EMBED_BASE_URL is unset', async () => {
    vi.stubEnv('EMBED_BASE_URL', '')
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', 'http://ollama.test:11434/v1')
    fetchMock.mockResolvedValueOnce(embedding([1, 0]))
    await localEmbedText('x', MODEL, 2)
    expect(sent().url).toBe('http://ollama.test:11434/v1/embeddings')
  })
})

describe('localEmbedImage', () => {
  it('sends the image as a data URL with its real type', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])
    fetchMock.mockResolvedValueOnce(embedding([0, 1]))
    await localEmbedImage(png, MODEL, 2)
    expect(sent().body.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }])
    fetchMock.mockResolvedValueOnce(embedding([0, 1]))
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(embedding([0, 1]))
    await localEmbedImage(Buffer.from([0xff, 0xd8, 0xff]), MODEL, 2)
    expect(sent().body.messages[1].content[0].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('refuses images in EMBED_REQUEST=input mode instead of sending text-only garbage', async () => {
    vi.stubEnv('EMBED_REQUEST', 'input')
    await expect(localEmbedImage(Buffer.from('x'), MODEL, 2)).rejects.toThrow(/cannot embed images/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
