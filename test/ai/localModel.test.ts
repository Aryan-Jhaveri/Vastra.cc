import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostedHooks, setHostedHooks } from '../../src/hostedHooks.js'

// #289 — `local/<name>` model ids route to the operator's OpenAI-compatible
// server. The master OpenRouter key is set on purpose: nothing on this path
// may read it, or a per-user key.
const { insert, getKey, fetchMock, generateContent } = vi.hoisted(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-master'
  return { insert: vi.fn(), getKey: vi.fn(), fetchMock: vi.fn(), generateContent: vi.fn() }
})
vi.mock('../../src/ai/aiCalls.js', () => ({ insertAiCall: insert }))
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent } } }))

import { generateJSONWithUsage, generateMessages, generateText, providerForModel, streamMessages } from '../../src/ai/client.js'
import { runInstrumented, generateMessagesInstrumented } from '../../src/ai/instrumented.js'
import { detectionModel, FREE_TASK_GEMINI_MODEL, freeTextModel, isLocalModelConfigured, localModelConfig, LOCAL_MAX_RESPONSE_BYTES } from '../../src/ai/localModel.js'
import { computeWholesaleCost } from '../../src/cost/tokenTable.js'
import { isTextModelConfigured } from '../../src/agent/chatEnabled.js'
import { agentModel } from '../../src/agent/model.js'
import type { MessageRequest } from '../../src/ai/messages.js'

const BASE = 'http://llm.test:8080/v1'

function completion(content: string | null, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: extra.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function sseResponse(frames: unknown[]) {
  const text = frames.map(f => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close() },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function sent(i = 0): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return { url, init, body: JSON.parse(String(init.body)) }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OPENAI_COMPAT_BASE_URL', `${BASE}/`)
  vi.stubEnv('OPENAI_COMPAT_API_KEY', '')
  getKey.mockReturnValue('sk-or-user')
})
// Any OpenRouter key lookup (per-user in the hosted run, the operator key in
// self-host) goes through this hook; a local model must never reach it.
beforeAll(() => {
  setHostedHooks({ ...hostedHooks(), resolveOpenRouterKey: getKey })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('local model config', () => {
  it('labels local/ ids as provider self, leaving other routing unchanged', () => {
    expect(providerForModel('local/qwen3-vl-8b')).toBe('self')
    expect(providerForModel('mistralai/mistral-small-3.2-24b-instruct')).toBe('openrouter')
  })

  it('strips the trailing slash and defaults the timeout', () => {
    expect(localModelConfig()).toEqual({ baseUrl: BASE, apiKey: undefined, timeoutMs: 180_000 })
  })

  it('fails with a clear error when the base URL is unset, and never falls through to another provider', async () => {
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', '')
    expect(isLocalModelConfigured()).toBe(false)
    await expect(generateText('hi', undefined, 'local/qwen3')).rejects.toThrow(/OPENAI_COMPAT_BASE_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(generateContent).not.toHaveBeenCalled()
  })

  it.each([
    ['file:///etc/passwd', /http\(s\)/],
    ['http://user:pass@llm.test/v1', /credentials/],
    ['not a url', /valid URL/],
  ])('rejects %s', (url, message) => {
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', url)
    expect(() => localModelConfig()).toThrow(message)
  })

  it('costs nothing, without a missing-price warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(computeWholesaleCost('self', 'local/qwen3', { tokensIn: 1_000_000, tokensOut: 1_000_000 })).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps free tasks on Gemini unless TEXT_MODEL is local (never OpenRouter credit)', () => {
    vi.stubEnv('TEXT_MODEL', '')
    expect(freeTextModel()).toBe(FREE_TASK_GEMINI_MODEL)
    vi.stubEnv('TEXT_MODEL', 'mistralai/mistral-small-3.2-24b-instruct')
    expect(freeTextModel()).toBe(FREE_TASK_GEMINI_MODEL)
    vi.stubEnv('TEXT_MODEL', 'local/qwen3-8b')
    expect(freeTextModel()).toBe('local/qwen3-8b')
  })

  it('detection follows a local VISION_MODEL unless DETECTION_MODEL is set', () => {
    vi.stubEnv('DETECTION_MODEL', '')
    vi.stubEnv('VISION_MODEL', '')
    expect(detectionModel()).toBe(FREE_TASK_GEMINI_MODEL)
    vi.stubEnv('VISION_MODEL', 'mistralai/pixtral-12b')
    expect(detectionModel()).toBe(FREE_TASK_GEMINI_MODEL)
    vi.stubEnv('VISION_MODEL', 'local/qwen3-vl-8b')
    expect(detectionModel()).toBe('local/qwen3-vl-8b')
    vi.stubEnv('DETECTION_MODEL', 'gemini-2.5-pro')
    expect(detectionModel()).toBe('gemini-2.5-pro')
  })

  it('chat follows a local TEXT_MODEL unless AGENT_MODEL is set', () => {
    vi.stubEnv('AGENT_MODEL', '')
    vi.stubEnv('TEXT_MODEL', 'mistralai/mistral-small-3.2-24b-instruct')
    expect(agentModel()).toBe(FREE_TASK_GEMINI_MODEL)
    vi.stubEnv('TEXT_MODEL', 'local/qwen3-8b')
    expect(agentModel()).toBe('local/qwen3-8b')
    vi.stubEnv('AGENT_MODEL', 'google/gemini-2.5-flash')
    expect(agentModel()).toBe('google/gemini-2.5-flash')
  })

  it('turns the Ask tab on for a local AGENT_MODEL only when the server URL is set', () => {
    vi.stubEnv('AGENT_MODEL', 'local/qwen3-8b')
    expect(isTextModelConfigured()).toBe(true)
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', '')
    expect(isTextModelConfigured()).toBe(false)
  })
})

describe('generateText / generateJSON on a local model', () => {
  it('posts to {base}/chat/completions with the prefix stripped and no bearer when no key is set', async () => {
    fetchMock.mockResolvedValueOnce(completion('hello'))
    await expect(generateText('hi', undefined, 'local/qwen3-vl-8b')).resolves.toBe('hello')
    const { url, init, body } = sent()
    expect(url).toBe(`${BASE}/chat/completions`)
    expect(body.model).toBe('qwen3-vl-8b')
    expect(body).not.toHaveProperty('response_format')
    expect(body).not.toHaveProperty('provider')
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    expect(init.redirect).toBe('error')
  })

  it('sends OPENAI_COMPAT_API_KEY as the bearer, never an OpenRouter key', async () => {
    vi.stubEnv('OPENAI_COMPAT_API_KEY', 'local-secret')
    fetchMock.mockResolvedValueOnce(completion('ok'))
    await generateText('hi', undefined, 'local/qwen3')
    expect(new Headers(sent().init.headers).get('Authorization')).toBe('Bearer local-secret')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('sk-or-')
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('openrouter.ai'))).toBe(true)
  })

  it('sends the image as an OpenAI image_url part and parses fenced JSON with usage', async () => {
    fetchMock.mockResolvedValueOnce(completion('```json\n{"category":"tops"}\n```'))
    const out = await generateJSONWithUsage<{ category: string }>('categorize', 'QUJD', 'local/qwen3-vl-8b')
    expect(out).toEqual({ data: { category: 'tops' }, usage: { tokensIn: 12, tokensOut: 5 } })
    const content = (sent().body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content
    expect(content).toEqual([
      { type: 'text', text: 'categorize' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ])
  })

  it('surfaces the server status on HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('model not loaded', { status: 404 }))
    await expect(generateText('hi', undefined, 'local/qwen3')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/Local model HTTP 404: model not loaded/) })
  })

  it('refuses a response over the size cap', async () => {
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(LOCAL_MAX_RESPONSE_BYTES + 1), { status: 200 }))
    await expect(generateText('hi', undefined, 'local/qwen3')).rejects.toThrow(/size cap/)
  })

  it('aborts after OPENAI_COMPAT_TIMEOUT_MS', async () => {
    vi.stubEnv('OPENAI_COMPAT_TIMEOUT_MS', '20')
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    await expect(generateText('hi', undefined, 'local/qwen3')).rejects.toThrow(/timeout|aborted/i)
  })
})

describe('message calls on a local model', () => {
  const tools = [{ name: 'search_closet', description: 'Search', parameters: { type: 'object' as const, properties: {} } }]
  const request: MessageRequest = { system: 'Be brief.', messages: [{ role: 'user', content: 'Find my navy shirt' }], tools }

  it('returns tool calls without an OpenRouter key', async () => {
    fetchMock.mockResolvedValueOnce(completion(null, {
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_closet', arguments: '{"q":"navy shirt"}' } }],
    }))
    const res = await generateMessages(request, 'local/qwen3-8b')
    expect(res.message.toolCalls).toEqual([{ id: 'c1', name: 'search_closet', arguments: { q: 'navy shirt' } }])
    const { body } = sent()
    expect(body.model).toBe('qwen3-8b')
    expect(body).not.toHaveProperty('provider')
    expect(body.tools).toHaveLength(1)
  })

  it('streams text and drops reasoning_content from local thinking models', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse([
      { choices: [{ index: 0, delta: { reasoning_content: 'the user wants…' } }] },
      { choices: [{ index: 0, delta: { content: 'Try the ' } }] },
      { choices: [{ index: 0, delta: { content: 'navy oxford.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } },
      '[DONE]',
    ]))
    const events = []
    for await (const e of streamMessages({ messages: [{ role: 'user', content: 'hi' }] }, 'local/qwen3-8b')) events.push(e)
    const done = events.at(-1)
    expect(done).toMatchObject({ type: 'complete', response: { message: { content: 'Try the navy oxford.' }, usage: { tokensIn: 30, tokensOut: 8 } } })
    expect(JSON.stringify(events)).not.toContain('the user wants')
  })
})

describe('instrumented local calls', () => {
  const base = { userId: 'alice', task: 'categorize' as const, model: 'local/qwen3-vl-8b', expectedBilledTokens: 0 }

  it('loads no per-user key, records provider self at zero cost, and keeps the user id off the wire', async () => {
    fetchMock.mockResolvedValueOnce(completion('ok'))
    await generateMessagesInstrumented({ ...base, request: { messages: [{ role: 'user', content: 'hi' }] } })
    expect(getKey).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', provider: 'self', model: 'local/qwen3-vl-8b', wholesaleCostCentsX100: 0, success: 1 }))
    expect(String(sent().init.body)).not.toContain('alice')
  })

  it('records a failed local call with provider self', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await expect(runInstrumented({ ...base, call: async () => ({ result: await generateText('hi', undefined, base.model) }) })).rejects.toThrow(/Local model HTTP 500/)
    expect(getKey).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', provider: 'self', success: 0 }))
  })
})
