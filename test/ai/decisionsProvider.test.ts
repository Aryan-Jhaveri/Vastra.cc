import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #332 — the decision provider is pluggable so self-hosters can choose their
// model: Jev on OpenRouter (default), any TypeSafe endpoint (e.g. CLM-8B), or
// Noul questions scored by any chat model (DECISIONS_PROVIDER=llm).
import { decisionsProviderInfo, generateDecisions, isDecisionsConfigured, JEV_MODEL } from '../../src/ai/decisions.js'
import { priceScheduleAt } from '../../src/cost/tokenTable.js'

const fetchMock = vi.fn()
const QUESTIONS = {
  q1: { type: 'noul' as const, instructions: 'Does this pair well with a navy blazer?' },
  q2: { type: 'noul' as const, instructions: 'Is it rain-proof?', criteria: { true: 'waterproof', false: 'not waterproof' } },
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const sent = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return { url, init, body: JSON.parse(String(init.body)) }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-master')
  vi.stubEnv('DECISIONS_PROVIDER', '')
  vi.stubEnv('DECISIONS_URL', '')
  vi.stubEnv('DECISIONS_API_KEY', '')
  vi.stubEnv('DECISIONS_MODEL', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('openrouter (default): Jev', () => {
  it('is configured by the master key and labelled typesafe / Jev', () => {
    expect(decisionsProviderInfo()).toEqual({ kind: 'openrouter', provider: 'typesafe', model: JEV_MODEL })
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(isDecisionsConfigured()).toBe(false)
  })

  it('reports an unknown cost as null, not 0, when OpenRouter omits usage.cost (#345)', async () => {
    fetchMock.mockResolvedValueOnce(json({ answers: { q1: { type: 'noul', noul: 0.7 }, q2: { type: 'noul', noul: 0.2 } }, usage: {} }))
    const result = await generateDecisions('state', QUESTIONS)
    expect(result.usage.cost).toBeNull()
    expect(result.priceScheduleId).toBeUndefined() // unknown cost: no schedule behind it (#344)
    expect(sent().body.provider).toEqual({ zdr: true })
  })
})

describe('typesafe: an operator-run TypeSafe endpoint (e.g. CLM-8B)', () => {
  beforeEach(() => {
    vi.stubEnv('DECISIONS_PROVIDER', 'typesafe')
    vi.stubEnv('DECISIONS_URL', 'http://clm.test:8700/v1/systemone')
  })

  it('posts state + questions to DECISIONS_URL, with no OpenRouter key or ZDR field', async () => {
    fetchMock.mockResolvedValueOnce(json({ answers: { q1: { type: 'noul', noul: 0.9 }, q2: { type: 'noul', noul: 0.1 } } }))
    const result = await generateDecisions({ anchor: 'white oxford' }, QUESTIONS)
    const { url, init, body } = sent()
    expect(url).toBe('http://clm.test:8700/v1/systemone')
    expect(body).toEqual({ state: { anchor: 'white oxford' }, questions: QUESTIONS })
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    expect(init.redirect).toBe('error')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('sk-or-')
    expect(result.answers.q1).toEqual({ type: 'noul', noul: 0.9 })
    expect(result.usage.cost).toBe(0) // own hardware
    expect(result.priceScheduleId).toBe(priceScheduleAt().id) // our free-provider rule, not a provider bill (#344)
    expect(decisionsProviderInfo()).toMatchObject({ kind: 'typesafe', provider: 'self' })
  })

  it('sends DECISIONS_API_KEY as bearer and DECISIONS_MODEL as model when set', async () => {
    vi.stubEnv('DECISIONS_API_KEY', 'clm-secret')
    vi.stubEnv('DECISIONS_MODEL', 'clm-v0.1-8b')
    fetchMock.mockResolvedValueOnce(json({ answers: { q1: { type: 'noul', noul: 0.5 }, q2: { type: 'noul', noul: 0.5 } } }))
    await generateDecisions('s', QUESTIONS)
    expect(new Headers(sent().init.headers).get('Authorization')).toBe('Bearer clm-secret')
    expect(sent().body.model).toBe('clm-v0.1-8b')
  })

  it.each(['', 'file:///etc/passwd', 'http://u:p@clm.test/v1'])('is not configured for DECISIONS_URL=%j', url => {
    vi.stubEnv('DECISIONS_URL', url)
    expect(isDecisionsConfigured()).toBe(false)
  })

  it('accepts clm-serve answers, which carry no `type`, typing them from the question asked', async () => {
    fetchMock.mockResolvedValueOnce(json({
      answers: {
        n: { noul: 0.41 },
        c: { choice: 'coat', probabilities: { coat: 0.94, tee: 0.06 } },
        s: { score: 1.98, confidence: 0.85, probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 } },
        stray: { noul: 1 },
      },
      usage: { input_tokens: 38, billing_units: 1 },
      latency_ms: 58.1,
    }))
    const result = await generateDecisions('s', {
      n: { type: 'noul', instructions: 'warm?' },
      c: { type: 'choice', criteria: { coat: 'coat', tee: 'tee' } },
      s: { type: 'score', criteria: ['light', 'medium', 'warm'] },
    })
    expect(result.answers).toEqual({
      n: { type: 'noul', noul: 0.41 },
      c: { type: 'choice', choice: 'coat', confidence: 0.94, probabilities: { coat: 0.94, tee: 0.06 } },
      s: { type: 'score', score: 1.98, confidence: 0.85, probabilities: { '0': 0.05, '1': 0.1, '2': 0.85 } },
    })
    expect(result.usage).toEqual({ cost: 0, inputTokens: 38, outputTokens: 0 })
  })

  it('shrinks an oversized question to DECISIONS_MAX_TOKENS before sending, keeping every item', async () => {
    vi.stubEnv('DECISIONS_MAX_TOKENS', '300')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = Array.from({ length: 6 }, (_, i) => ({ subcategory: `shirt ${i}`, description: 'long text '.repeat(40), tags: ['a', 'b'] }))
    fetchMock.mockResolvedValueOnce(json({ answers: { q: { noul: 0.5 } } }))
    await generateDecisions('s', { q: { type: 'noul', instructions: `Good pick? Outfit JSON: ${JSON.stringify({ items })}` } })
    const sentText = String(sent().body.questions.q.instructions)
    expect(sentText.length).toBeLessThanOrEqual(900)
    expect(JSON.parse(sentText.slice(sentText.indexOf('{'))).items).toHaveLength(6)
    warn.mockRestore()
  })

  it('runs under DECISIONS_MAX_CONCURRENCY: a second call waits for the first', async () => {
    vi.stubEnv('DECISIONS_MAX_CONCURRENCY', '1')
    let finish!: () => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(json({ answers: { q1: { noul: 0.1 }, q2: { noul: 0.2 } } })) }))
    fetchMock.mockResolvedValueOnce(json({ answers: { q1: { noul: 0.3 }, q2: { noul: 0.4 } } }))
    const first = generateDecisions('s', QUESTIONS)
    const second = generateDecisions('s', QUESTIONS)
    await new Promise(r => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish()
    expect((await first).answers.q1).toEqual({ type: 'noul', noul: 0.1 })
    expect((await second).answers.q1).toEqual({ type: 'noul', noul: 0.3 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never falls through to OpenRouter on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }))
    await expect(generateDecisions('s', QUESTIONS)).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('llm: Noul questions scored by any chat model', () => {
  beforeEach(() => {
    vi.stubEnv('DECISIONS_PROVIDER', 'llm')
    vi.stubEnv('DECISIONS_MODEL', 'local/qwen3-8b')
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', 'http://llm.test:8080/v1')
  })

  function chat(content: string) {
    return json({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10 } })
  }

  it('asks the chat model for one probability per question and clamps to 0–1', async () => {
    fetchMock.mockResolvedValueOnce(chat('```json\n{"q1": 0.83, "q2": 1.4}\n```'))
    const result = await generateDecisions({ anchor: 'white oxford' }, QUESTIONS)
    expect(result.answers).toEqual({ q1: { type: 'noul', noul: 0.83 }, q2: { type: 'noul', noul: 1 } })
    const prompt = sent().body.messages[0].content[0].text as string
    expect(prompt).toContain('q2: Is it rain-proof? (yes means: waterproof) (no means: not waterproof)')
    expect(sent().url).toBe('http://llm.test:8080/v1/chat/completions')
    expect(result.usage.cost).toBe(0) // local model: free, known
    expect(result.priceScheduleId).toBe(priceScheduleAt().id)
    expect(decisionsProviderInfo()).toEqual({ kind: 'llm', provider: 'self', model: 'local/qwen3-8b' })
  })

  it('fails (so callers fall back) when an answer is missing', async () => {
    fetchMock.mockResolvedValueOnce(chat('{"q1": 0.5}'))
    await expect(generateDecisions('s', QUESTIONS)).rejects.toThrow(/missing for "q2"/)
  })

  it('refuses choice/score questions instead of guessing', async () => {
    await expect(generateDecisions('s', { c: { type: 'choice', criteria: { a: 'A', b: 'B' } } })).rejects.toThrow(/noul questions only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is configured only when its chat model is usable', () => {
    expect(isDecisionsConfigured()).toBe(true)
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', '')
    expect(isDecisionsConfigured()).toBe(false)
    vi.stubEnv('DECISIONS_MODEL', '')
    expect(isDecisionsConfigured()).toBe(false)
  })
})

describe('rails that apply to every provider', () => {
  it('still refuses user_* state keys before any request', async () => {
    vi.stubEnv('DECISIONS_PROVIDER', 'typesafe')
    vi.stubEnv('DECISIONS_URL', 'http://clm.test/v1/systemone')
    await expect(generateDecisions({ user_id: 'alice' }, QUESTIONS)).rejects.toThrow(/user_/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an unknown provider name is not configured and throws', async () => {
    vi.stubEnv('DECISIONS_PROVIDER', 'magic')
    expect(isDecisionsConfigured()).toBe(false)
    await expect(generateDecisions('s', QUESTIONS)).rejects.toThrow(/unknown DECISIONS_PROVIDER/)
  })
})
