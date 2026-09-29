import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { requireSession, requireAdmin } from '../../../../src/transport/web/middleware.js'
import connectorsRouter from '../../../../src/transport/web/routes/connectors.js'
import sharp from 'sharp'
import { __resetModelServerSlots } from '../../../../src/ai/modelServers.js'
import { __resetImageGenUsers } from '../../../../src/ai/localImage.js'

// #289 — admin-only Test connection for the self-hosted model server.
const BASE = 'http://llm.test:8080/v1'
const KEY = 'local-secret-key'
const fetchMock = vi.fn()

function appAs(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.use('/', requireAdmin, connectorsRouter)
  return app
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A server that lists one model and answers chat + vision, optionally tools. */
function server({ tools = true, vision = true } = {}) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/models')) return json({ data: [{ id: 'qwen3-vl-8b' }] })
    const body = JSON.parse(String(init.body))
    if (body.tools) return json({ choices: [{ message: tools ? { content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'ping', arguments: '{}' } }] } : { content: 'pong' } }] })
    if (Array.isArray(body.messages[0].content)) return vision ? json({ choices: [{ message: { content: 'white' } }] }) : json({ error: 'image input not supported' }, 400)
    return json({ choices: [{ message: { content: 'ok' } }] })
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OPENAI_COMPAT_BASE_URL', BASE)
  vi.stubEnv('OPENAI_COMPAT_API_KEY', KEY)
  vi.stubEnv('AGENT_MODEL', '')
  vi.stubEnv('VISION_MODEL', '')
  vi.stubEnv('TEXT_MODEL', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('POST /local/test — auth', () => {
  it('401 without a session', async () => {
    const app = express()
    app.use(express.json())
    app.use('/', requireSession, requireAdmin, connectorsRouter)
    expect((await request(app).post('/local/test')).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 for a normal user, with no probe sent', async () => {
    const res = await request(appAs('user-abc')).post('/local/test')
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /local/test — probes', () => {
  it('reports each capability separately and never echoes the key', async () => {
    server()
    const res = await request(appAs('self')).post('/local/test').send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true, baseUrl: BASE, model: 'qwen3-vl-8b', models: ['qwen3-vl-8b'],
      checks: { models: { ok: true }, chat: { ok: true }, vision: { ok: true }, tools: { ok: true } },
    })
    expect(JSON.stringify(res.body)).not.toContain(KEY)
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(`Bearer ${KEY}`)
    }
  })

  it('flags missing vision and tool support without failing chat', async () => {
    server({ tools: false, vision: false })
    const res = await request(appAs('self')).post('/local/test').send({})
    expect(res.body.ok).toBe(true)
    expect(res.body.checks.vision).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 400/) })
    expect(res.body.checks.tools).toMatchObject({ ok: false, error: expect.stringMatching(/without calling the tool/) })
  })

  it('prefers the requested model, then a configured local/ model id', async () => {
    server()
    vi.stubEnv('VISION_MODEL', 'local/from-env')
    expect((await request(appAs('self')).post('/local/test').send({})).body.model).toBe('from-env')
    expect((await request(appAs('self')).post('/local/test').send({ model: 'local/picked' })).body.model).toBe('picked')
    const sentModels = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/chat/completions')).map(([, i]) => JSON.parse(String((i as RequestInit).body)).model)
    expect(new Set(sentModels)).toEqual(new Set(['from-env', 'picked']))
  })

  it('only ever calls the configured base URL, whatever the body says', async () => {
    server()
    await request(appAs('self')).post('/local/test').send({ baseUrl: 'http://169.254.169.254/latest', url: 'http://evil.test' })
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith(`${BASE}/`))).toBe(true)
  })

  it('rejects a malformed model id', async () => {
    const res = await request(appAs('self')).post('/local/test').send({ model: 'x y\n' })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400 with a clear message when no server is configured', async () => {
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', '')
    const res = await request(appAs('self')).post('/local/test')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/OPENAI_COMPAT_BASE_URL/)
  })

  it('redacts the key if a server error echoes it', async () => {
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/models')
      ? json({ data: [{ id: 'm' }] })
      : new Response(`bad key ${KEY}`, { status: 401 }))
    const res = await request(appAs('self')).post('/local/test').send({})
    expect(res.body.ok).toBe(false)
    expect(res.body.checks.chat.error).toContain('[redacted]')
    expect(JSON.stringify(res.body)).not.toContain(KEY)
  })
})

describe('POST /decisions/test (#351)', () => {
  const CLM = 'http://clm.test:8700/v1/systemone'
  const CLM_KEY = 'clm-secret-key'

  beforeEach(() => {
    vi.stubEnv('DECISIONS_PROVIDER', 'typesafe')
    vi.stubEnv('DECISIONS_URL', CLM)
    vi.stubEnv('DECISIONS_API_KEY', CLM_KEY)
  })

  /** A clm-serve lookalike: bare answers with no `type`, and GET /health. */
  function clmServe({ healthy = true } = {}) {
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit) => {
      if (String(url) === 'http://clm.test:8700/health') return healthy ? json({ status: 'ok' }) : new Response('', { status: 404 })
      const body = JSON.parse(String(init.body))
      const q = body.questions.probe
      if (q.type === 'noul') return json({ answers: { probe: { noul: 0.93 } } })
      if (q.type === 'choice') return json({ answers: { probe: { choice: 'coat', confidence: 0.9, probabilities: { coat: 0.9, tee: 0.1 } } } })
      return json({ answers: { probe: { score: 2, confidence: 0.8, probabilities: { '2': 0.8 } } } })
    })
  }

  it('403 for a normal user, with no probe sent', async () => {
    expect((await request(appAs('user-abc')).post('/decisions/test')).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('probes noul, choice and score against clm-serve and reports health, never echoing the key', async () => {
    clmServe()
    const res = await request(appAs('self')).post('/decisions/test')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      ok: true, provider: 'typesafe', endpoint: CLM,
      checks: { health: { ok: true }, noul: { ok: true }, choice: { ok: true }, score: { ok: true } },
    })
    expect(JSON.stringify(res.body)).not.toContain(CLM_KEY)
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(`Bearer ${CLM_KEY}`)
    }
  })

  it('a missing /health is reported without failing the probes', async () => {
    clmServe({ healthy: false })
    const res = await request(appAs('self')).post('/decisions/test')
    expect(res.body.ok).toBe(true)
    expect(res.body.checks.health).toEqual({ ok: false, error: 'HTTP 404' })
  })

  it('flags an answer that is not one of the options', async () => {
    fetchMock.mockImplementation(async (url: string | URL, init: RequestInit) => {
      if (String(url).endsWith('/health')) return json({})
      const q = JSON.parse(String(init.body)).questions.probe
      return json({ answers: { probe: q.type === 'choice' ? { choice: 'jumper', probabilities: { jumper: 1 } } : q.type === 'noul' ? { noul: 0.5 } : { score: 1 } } })
    })
    const res = await request(appAs('self')).post('/decisions/test')
    expect(res.body.checks.choice).toMatchObject({ ok: false, error: 'choice is not one of the options' })
  })

  it('redacts the key if the server echoes it', async () => {
    fetchMock.mockImplementation(async () => new Response(`bad key ${CLM_KEY}`, { status: 401 }))
    const res = await request(appAs('self')).post('/decisions/test')
    expect(res.body.ok).toBe(false)
    expect(res.body.checks.noul.error).toContain('[redacted]')
    expect(JSON.stringify(res.body)).not.toContain(CLM_KEY)
  })

  it('400 with setup guidance when no provider is configured', async () => {
    vi.stubEnv('DECISIONS_PROVIDER', 'typesafe')
    vi.stubEnv('DECISIONS_URL', '')
    const res = await request(appAs('self')).post('/decisions/test')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/DECISIONS_URL/)
  })
})

describe('POST /image/test (#352)', () => {
  const IMG = 'http://img.test:8091/v1'
  const IMG_KEY = 'img-secret-key'

  beforeEach(() => {
    __resetModelServerSlots()
    __resetImageGenUsers()
    vi.stubEnv('IMAGE_GEN_MODEL', 'local/Qwen/Qwen-Image-2.1')
    vi.stubEnv('IMAGE_GEN_BASE_URL', IMG)
    vi.stubEnv('IMAGE_GEN_API_KEY', IMG_KEY)
  })

  it('403 for a normal user, with no probe sent', async () => {
    expect((await request(appAs('user-abc')).post('/image/test')).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400 when IMAGE_GEN_MODEL is not a local/ model', async () => {
    vi.stubEnv('IMAGE_GEN_MODEL', 'gemini-2.5-flash-image')
    const res = await request(appAs('self')).post('/image/test')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/local\//)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs one small edit and reports latency, output size and peak memory', async () => {
    const out = (await sharp({ create: { width: 32, height: 48, channels: 3, background: { r: 0, g: 0, b: 128 } } }).jpeg().toBuffer()).toString('base64')
    fetchMock.mockResolvedValueOnce(json({ data: [{ b64_json: out }], metrics: { peak_memory_mb: 28000 } }))
    const res = await request(appAs('self')).post('/image/test')
    expect(res.body).toMatchObject({
      ok: true, model: 'local/Qwen/Qwen-Image-2.1', endpoint: IMG, maxRefs: 4,
      checks: { edit: { ok: true, width: 32, height: 48, peakMemoryMb: 28000 } },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${IMG}/images/edits`)
    expect((init.body as FormData).get('num_inference_steps')).toBe('4')
  })

  it('reports a failed edit with the key redacted', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`unauthorized ${IMG_KEY}`, { status: 401 }))
    const res = await request(appAs('self')).post('/image/test')
    expect(res.body.ok).toBe(false)
    expect(res.body.checks.edit.error).toContain('[redacted]')
    expect(JSON.stringify(res.body)).not.toContain(IMG_KEY)
  })
})
