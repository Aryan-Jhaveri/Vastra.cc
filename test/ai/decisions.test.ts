import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PROVIDER_REPORTED_COST } from '../../src/cost/tokenTable.js'

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const validNoulResponse = {
  model: 'typesafe/jev-1.13',
  id: 'req_abc',
  provider: 'typesafe',
  answers: {
    q_outfit1: { type: 'noul', noul: 0.82 },
    q_outfit2: { type: 'noul', noul: 0.34 },
  },
  usage: { cost: 0.00012, input_tokens: 240, output_tokens: 0 },
}

describe('generateDecisions', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-master-key'
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends provider.zdr=true and Authorization bearer, returns native answers + usage.cost', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))

    const { generateDecisions } = await import('../../src/ai/decisions.js')
    const result = await generateDecisions(
      { weather: { temperature_c: 15 }, occasion: 'work' },
      { q1: { type: 'noul', instructions: 'Is this a good pick?' } },
    )

    expect(fetchSpy).toHaveBeenCalledOnce()
    const init = fetchSpy.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-or-v1-test-master-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('typesafe/jev-1.13')
    expect(body.provider).toEqual({ zdr: true }) // non-negotiable invariant
    expect(body.state).toEqual({ weather: { temperature_c: 15 }, occasion: 'work' })
    expect(body.questions.q1.type).toBe('noul')

    expect(result.answers.q_outfit1).toEqual({ type: 'noul', noul: 0.82 })
    expect(result.answers.q_outfit2).toEqual({ type: 'noul', noul: 0.34 })
    expect(result.usage.cost).toBe(0.00012)
    expect(result.priceScheduleId).toBe(PROVIDER_REPORTED_COST) // OpenRouter's own bill (#344)
    expect(result.usage.inputTokens).toBe(240)
    expect(result.usage.outputTokens).toBe(0)
    expect(result.model).toBe('typesafe/jev-1.13')
    expect(result.id).toBe('req_abc')
  })

  it('cross-user isolation: no userId appears in the outbound state or questions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))

    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await generateDecisions(
      { weather: { temperature_c: 15 }, occasion: 'work', closet_size: 30 } as Record<string, unknown>,
      { q1: { type: 'noul', instructions: 'good pick?' } },
    )

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    const serialized = JSON.stringify(body)
    // No raw userId, user_id, or user-prefixed key leaks into the payload.
    expect(serialized).not.toContain('user_id')
    expect(serialized).not.toContain('userId')
    expect(serialized).not.toContain('self')
    expect(Object.keys(body.state).every((k: string) => !k.startsWith('user_'))).toBe(true)
  })

  it('defensive rail rejects state fields whose key starts with user_ before the fetch fires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))

    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await expect(
      generateDecisions(
        { weather: { temperature_c: 15 }, user_id: 'u_abc', user_name: 'Aryan' } as Record<string, unknown>,
        { q1: { type: 'noul', instructions: 'x?' } },
      ),
    ).rejects.toThrow(/user_/)

    // The rail throws BEFORE the fetch call — no network request should fire.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts string state (no keys to leak) without invoking the defensive rail', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    const result = await generateDecisions('It is 5°C and rainy. I need office attire.', {
      q1: { type: 'noul', instructions: 'good pick?' },
    })
    expect(result.answers.q_outfit1.noul).toBe(0.82)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('throws on HTTP 4xx (caller falls back to Gemini)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ error: 'rate limited' }, 429))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    const err = await generateDecisions(
      { weather: { temperature_c: 15 } },
      { q1: { type: 'noul', instructions: 'x?' } },
    ).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/HTTP 429/)
    expect((err as { status?: number }).status).toBe(429)
  })

  it('throws on HTTP 5xx (caller falls back to Gemini)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({ error: 'upstream down' }, 503))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await expect(
      generateDecisions({ weather: { temperature_c: 15 } }, { q1: { type: 'noul', instructions: 'x?' } }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('throws a clear error if OPENROUTER_API_KEY is unset (fails closed)', async () => {
    delete process.env.OPENROUTER_API_KEY
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await expect(
      generateDecisions({ weather: { temperature_c: 15 } }, { q1: { type: 'noul', instructions: 'x?' } }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects empty questions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await expect(generateDecisions({ weather: {} }, {})).rejects.toThrow(/non-empty/)
  })

  it('Zod-validates a choice answer shape', async () => {
    const choiceResponse = {
      model: 'typesafe/jev-1.13',
      id: 'req_choice',
      answers: {
        best: {
          type: 'choice',
          choice: 'outfit_a',
          confidence: 0.74,
          probabilities: { outfit_a: 0.74, outfit_b: 0.26 },
        },
      },
      usage: { cost: 0.00008, input_tokens: 120, output_tokens: 0 },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(choiceResponse))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    const result = await generateDecisions({ weather: { temperature_c: 15 } }, {
      best: { type: 'choice', instructions: 'pick', criteria: { outfit_a: 'A', outfit_b: 'B' } },
    })
    expect(result.answers.best).toEqual({
      type: 'choice', choice: 'outfit_a', confidence: 0.74,
      probabilities: { outfit_a: 0.74, outfit_b: 0.26 },
    })
    expect(result.usage.cost).toBe(0.00008)
  })

  it('throws on a malformed response (Zod schema validation)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse({
      answers: { q1: { type: 'noul', noul: 'not-a-number' } },
      usage: {},
    }))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await expect(
      generateDecisions({ weather: {} }, { q1: { type: 'noul', instructions: 'x?' } }),
    ).rejects.toThrow()
  })

  it('always hardcodes provider.zdr even if caller tries to pass it via state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(validNoulResponse))
    const { generateDecisions } = await import('../../src/ai/decisions.js')
    await generateDecisions(
      { weather: { temperature_c: 15 } } as Record<string, unknown>,
      { q1: { type: 'noul', instructions: 'x?' } },
    )
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.provider).toEqual({ zdr: true })
  })
})
