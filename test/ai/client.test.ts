import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockModelsGenerateContent = vi.fn().mockResolvedValue({ text: 'gemini response' })
const mockFetch = vi.fn()

vi.hoisted(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  process.env.OPENROUTER_API_KEY = ''
})

vi.mock('@google/genai', () => {
  function MockGoogleGenAI(this: any, _opts: any) {
    this.models = { generateContent: mockModelsGenerateContent }
  }
  return { GoogleGenAI: MockGoogleGenAI }
})

describe('OPENROUTER_DISABLED kill switch', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    global.fetch = mockFetch as unknown as typeof fetch
    mockModelsGenerateContent.mockResolvedValue({ text: 'gemini response' })
    delete process.env.OPENROUTER_DISABLED
  })

  it('routes OpenRouter model through Vertex when OPENROUTER_DISABLED=true', async () => {
    process.env.OPENROUTER_DISABLED = 'true'
    const { generateText } = await import('../../../src/ai/client.js')

    const result = await generateText('test prompt', undefined, 'mistralai/mistral-small')

    expect(result).toBe('gemini response')
    expect(mockModelsGenerateContent).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('routes OpenRouter model through Vertex when OPENROUTER_DISABLED=true (with image)', async () => {
    process.env.OPENROUTER_DISABLED = 'true'
    const { generateText } = await import('../../../src/ai/client.js')

    const result = await generateText('test prompt', 'aW1hZ2VkYXRh', 'mistralai/mistral-small')

    expect(result).toBe('gemini response')
    expect(mockModelsGenerateContent).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('routes OpenRouter model through Vertex when OPENROUTER_DISABLED=true (generateTextWithUsage)', async () => {
    process.env.OPENROUTER_DISABLED = 'true'
    mockModelsGenerateContent.mockResolvedValue({ text: 'gemini response', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })
    const { generateTextWithUsage } = await import('../../../src/ai/client.js')

    const { text, usage } = await generateTextWithUsage('test', undefined, 'mistralai/mistral-small')

    expect(text).toBe('gemini response')
    expect(usage.tokensIn).toBe(10)
    expect(usage.tokensOut).toBe(5)
    expect(mockModelsGenerateContent).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('still routes through OpenRouter when OPENROUTER_DISABLED is not set', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'openrouter response' } }] }),
    })
    process.env.OPENROUTER_API_KEY = 'sk-test'

    const { generateText } = await import('../../../src/ai/client.js')
    const result = await generateText('test', undefined, 'mistralai/mistral-small')

    expect(result).toBe('openrouter response')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
