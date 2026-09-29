import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetModelServerSlots, acquireSlot, isModelServerConfigured, ModelServerBusyError, modelServerConfig,
  modelServerLoad, readJsonCapped, serverFetch,
} from '../../src/ai/modelServers.js'
import { isModelBusy } from '../../src/ai/client.js'

const fetchMock = vi.fn()

beforeEach(() => {
  __resetModelServerSlots()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  for (const name of [
    'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY', 'IMAGE_GEN_BASE_URL', 'IMAGE_GEN_API_KEY',
    'EMBED_BASE_URL', 'EMBED_API_KEY', 'DECISIONS_URL', 'DECISIONS_API_KEY',
    'IMAGE_GEN_MAX_CONCURRENCY', 'IMAGE_GEN_MAX_QUEUE', 'IMAGE_GEN_TIMEOUT_MS',
  ]) vi.stubEnv(name, '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tick = () => new Promise(r => setTimeout(r, 0))

describe('modelServerConfig', () => {
  it('reads each capability from its own variables with per-capability defaults', () => {
    vi.stubEnv('IMAGE_GEN_BASE_URL', 'http://qwen-image:8091/v1/')
    vi.stubEnv('IMAGE_GEN_API_KEY', 'img-key')
    vi.stubEnv('DECISIONS_URL', 'http://clm:8700/v1/systemone')
    expect(modelServerConfig('image')).toMatchObject({
      baseUrl: 'http://qwen-image:8091/v1', apiKey: 'img-key', timeoutMs: 300_000, maxConcurrency: 1, maxQueue: 32, urlSource: 'IMAGE_GEN_BASE_URL',
    })
    // The TypeSafe URL is the full endpoint, kept as-is.
    expect(modelServerConfig('decisions')).toMatchObject({ baseUrl: 'http://clm:8700/v1/systemone', maxConcurrency: 4, timeoutMs: 30_000 })
  })

  it('falls back to the chat server (and its key) for image and embed, never for decisions', () => {
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', 'http://ollama:11434/v1')
    vi.stubEnv('OPENAI_COMPAT_API_KEY', 'chat-key')
    expect(modelServerConfig('embed')).toMatchObject({ baseUrl: 'http://ollama:11434/v1', apiKey: 'chat-key', urlSource: 'OPENAI_COMPAT_BASE_URL' })
    vi.stubEnv('EMBED_API_KEY', 'embed-key')
    expect(modelServerConfig('embed').apiKey).toBe('embed-key')
    expect(isModelServerConfigured('decisions')).toBe(false)
  })

  it('does not lend the chat key to a capability with its own URL', () => {
    vi.stubEnv('OPENAI_COMPAT_API_KEY', 'chat-key')
    vi.stubEnv('EMBED_BASE_URL', 'http://embed:8002/v1')
    expect(modelServerConfig('embed').apiKey).toBeUndefined()
  })

  it.each([
    ['file:///etc/passwd', /http\(s\)/],
    ['http://user:pass@clm:8700/v1/systemone', /credentials/],
    ['not a url', /valid URL/],
  ])('rejects %s', (url, message) => {
    vi.stubEnv('DECISIONS_URL', url)
    expect(() => modelServerConfig('decisions')).toThrow(message)
  })

  it('names the variable to set when unconfigured', () => {
    expect(() => modelServerConfig('image')).toThrow(/IMAGE_GEN_BASE_URL \(or OPENAI_COMPAT_BASE_URL\)/)
  })

  it('ignores non-positive or fractional limits', () => {
    vi.stubEnv('IMAGE_GEN_BASE_URL', 'http://img/v1')
    vi.stubEnv('IMAGE_GEN_MAX_CONCURRENCY', '0')
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '1.5')
    expect(modelServerConfig('image')).toMatchObject({ maxConcurrency: 1, timeoutMs: 300_000 })
  })
})

describe('in-flight limit', () => {
  beforeEach(() => vi.stubEnv('IMAGE_GEN_BASE_URL', 'http://img/v1'))

  it('queues past the cap in FIFO order and fails fast when the queue is full', async () => {
    vi.stubEnv('IMAGE_GEN_MAX_QUEUE', '2')
    const config = modelServerConfig('image')
    const first = await acquireSlot(config)
    const order: string[] = []
    const a = acquireSlot(config).then(r => { order.push('a'); return r })
    const b = acquireSlot(config).then(r => { order.push('b'); return r })
    await expect(acquireSlot(config)).rejects.toBeInstanceOf(ModelServerBusyError)
    expect(modelServerLoad('image')).toEqual({ active: 1, queued: 2 })

    first()
    first() // a second release of the same slot is ignored
    const releaseA = await a
    await tick()
    expect(order).toEqual(['a'])
    expect(modelServerLoad('image')).toEqual({ active: 1, queued: 1 })
    releaseA()
    ;(await b)()
    expect(order).toEqual(['a', 'b'])
    expect(modelServerLoad('image')).toEqual({ active: 0, queued: 0 })
  })

  it('a full queue reads as model-busy (503) so callers retry or show the busy message', () => {
    expect(isModelBusy(new ModelServerBusyError('image', 32))).toBe(true)
  })

  it('an aborted waiter leaves the queue and never takes a slot', async () => {
    const config = modelServerConfig('image')
    const release = await acquireSlot(config)
    const controller = new AbortController()
    const waiting = acquireSlot(config, controller.signal)
    controller.abort(new Error('gave up'))
    await expect(waiting).rejects.toThrow('gave up')
    expect(modelServerLoad('image')).toEqual({ active: 1, queued: 0 })
    release()
    expect(modelServerLoad('image')).toEqual({ active: 0, queued: 0 })
  })

  it('the timeout covers time spent waiting in the queue', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '20')
    const release = await acquireSlot(modelServerConfig('image'))
    await expect(serverFetch('image', '/images/edits', { body: {} })).rejects.toThrow(/timeout|aborted/i)
    expect(fetchMock).not.toHaveBeenCalled()
    release()
  })
})

describe('serverFetch', () => {
  beforeEach(() => {
    vi.stubEnv('IMAGE_GEN_BASE_URL', 'http://img/v1')
    vi.stubEnv('IMAGE_GEN_API_KEY', 'sekret')
  })

  it('sends JSON with the bearer, refuses redirects, and holds the slot until the body is read', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }))
    const res = await serverFetch('image', '/images/generations', { body: { prompt: 'x' } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://img/v1/images/generations')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer sekret', 'Content-Type': 'application/json' } })
    expect(modelServerLoad('image').active).toBe(1)
    expect(await readJsonCapped(res, 1024)).toEqual({ ok: true })
    expect(modelServerLoad('image').active).toBe(0)
  })

  it('sends FormData as multipart (no JSON content type)', async () => {
    fetchMock.mockResolvedValueOnce(json({}))
    const form = new FormData()
    form.append('prompt', 'x')
    await (await serverFetch('image', '/images/edits', { body: form })).text()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(form)
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('a streaming body keeps the slot until fully consumed or cancelled', async () => {
    const enc = new TextEncoder()
    let push!: (s: string) => void
    let end!: () => void
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(c) { push = s => c.enqueue(enc.encode(s)); end = () => c.close() },
    })))
    const res = await serverFetch('image', '/stream', { body: {} })
    const reader = res.body!.getReader()
    push('a')
    await reader.read()
    expect(modelServerLoad('image').active).toBe(1)
    end()
    await reader.read()
    expect(modelServerLoad('image').active).toBe(0)

    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode('x')) } })))
    const res2 = await serverFetch('image', '/stream', { body: {} })
    expect(modelServerLoad('image').active).toBe(1)
    await res2.body!.cancel()
    expect(modelServerLoad('image').active).toBe(0)
  })

  it('releases the slot and redacts the key on HTTP errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad key sekret', { status: 401 }))
    await expect(serverFetch('image', '/images/edits', { body: {} })).rejects.toMatchObject({
      status: 401, message: 'Image server HTTP 401: bad key [redacted]',
    })
    expect(modelServerLoad('image').active).toBe(0)
  })

  it('releases the slot when the request itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(serverFetch('image', '/x', { body: {} })).rejects.toThrow('fetch failed')
    expect(modelServerLoad('image').active).toBe(0)
  })

  it('readJsonCapped refuses an oversized body', async () => {
    await expect(readJsonCapped(new Response('x'.repeat(100)), 10)).rejects.toThrow(/size cap/)
  })
})
