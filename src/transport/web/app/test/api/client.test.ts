import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

interface MockResponseOpts {
  status: number
  body: unknown
}

function mockResponse({ status, body }: MockResponseOpts): Response {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body)
  const r = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: () => Promise.resolve(bodyText),
    clone: () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: () => Promise.resolve(bodyText),
    }),
  }
  return r as unknown as Response
}

describe('client — 402 handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  it('apiFetchJSON throws InsufficientTokensError on 402', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 402, body: {
      error: 'Insufficient tokens',
      code: 'INSUFFICIENT_TOKENS',
      required: 12,
      balance: 3,
    } }))

    const { apiFetchJSON, InsufficientTokensError } = await import('../../src/api/client')

    let caught: unknown = null
    try {
      await apiFetchJSON('/api/something')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(InsufficientTokensError)
    expect((caught as any).required).toBe(12)
    expect((caught as any).balance).toBe(3)
  })

  it('402 dispatches window custom event with detail', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 402, body: {
      error: 'Insufficient tokens',
      code: 'INSUFFICIENT_TOKENS',
      required: 16,
      balance: 4,
    } }))

    const { apiFetchJSON } = await import('../../src/api/client')

    const listener = vi.fn()
    window.addEventListener('insufficient-tokens', listener)

    try {
      await apiFetchJSON('/api/something')
    } catch { /* expected */ }

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ required: 16, balance: 4 })

    window.removeEventListener('insufficient-tokens', listener)
  })

  it('throws clear error on empty 200 response body', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 200, body: '' }))

    const { apiFetchJSON } = await import('../../src/api/client')

    let caught: unknown = null
    try {
      await apiFetchJSON('/api/billing/wallet')
    } catch (e) {
      caught = e
    }

    expect((caught as Error).message).toMatch(/Empty response/)
  })

  it('res.clone() preserves body for second read after 402 peek', async () => {
    const errorBody = {
      error: 'Insufficient tokens',
      code: 'INSUFFICIENT_TOKENS',
      required: 16,
      balance: 4,
    }
    const successBody = { items: [] }

    let callCount = 0
    mockFetch.mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(mockResponse({ status: 402, body: errorBody }))
      }
      return Promise.resolve(mockResponse({ status: 200, body: successBody }))
    })

    const { apiFetchJSON } = await import('../../src/api/client')

    try {
      await apiFetchJSON('/api/tryon')
    } catch { /* expected 402 */ }

    const result = await apiFetchJSON('/api/items?limit=1')
    expect(result).toEqual(successBody)
  })
})

describe('client — cookie-only sessions (#295)', () => {
  const LEGACY_AUTH_KEY = 'closet-auth-token'
  const LEGACY_REMEMBER_KEY = 'closet-auth-remember'

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('apiFetch sends the CSRF proof header and never an Authorization header', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 200, body: {} }))

    const { apiFetch } = await import('../../src/api/client')
    await apiFetch('/api/items', { method: 'POST', body: JSON.stringify({}) })

    const [path, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/items')
    const headers = new Headers(init.headers)
    expect(headers.get('X-Requested-With')).toBe('vastra')
    expect(headers.get('Authorization')).toBeNull()
  })

  it('no sign-in flow can store a session token: the storage API is never written', async () => {
    // The module must not export any way to persist a token — the strongest
    // guarantee that localStorage/sessionStorage can never hold one.
    const client = await import('../../src/api/client')
    const exports = Object.keys(client) as Array<keyof typeof client>
    expect(exports).not.toContain('setToken')
    expect(exports).not.toContain('getToken')

    expect(localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull()
    expect(sessionStorage.getItem(LEGACY_AUTH_KEY)).toBeNull()
  })

  it('purgeLegacyTokenStorage removes tokens left by the pre-#295 build', async () => {
    localStorage.setItem(LEGACY_AUTH_KEY, 'stale-token')
    localStorage.setItem(LEGACY_REMEMBER_KEY, 'true')
    sessionStorage.setItem(LEGACY_AUTH_KEY, 'stale-token-2')

    const { purgeLegacyTokenStorage } = await import('../../src/api/client')
    purgeLegacyTokenStorage()

    expect(localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_REMEMBER_KEY)).toBeNull()
    expect(sessionStorage.getItem(LEGACY_AUTH_KEY)).toBeNull()
  })

  it('clearSessionState purges legacy token keys and sessionStorage', async () => {
    localStorage.setItem(LEGACY_AUTH_KEY, 'stale-token')
    sessionStorage.setItem('some-user-state', '1')

    const { clearSessionState } = await import('../../src/api/client')
    clearSessionState()

    expect(localStorage.getItem(LEGACY_AUTH_KEY)).toBeNull()
    expect(sessionStorage.getItem('some-user-state')).toBeNull()
  })

  it('apiFetch clears private state and redirects on a rejected session (401)', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 401, body: { error: 'Unauthorized' } }))
    const originalHref = window.location.href
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: 'about:blank' },
    })
    sessionStorage.setItem('user-state', 'keep-me-out')

    const { apiFetch } = await import('../../src/api/client')
    const res = await apiFetch('/api/items')
    expect(res.status).toBe(401)

    expect(sessionStorage.getItem('user-state')).toBeNull()
    expect((window.location as { href: string }).href).toBe('/')

    Object.defineProperty(window, 'location', { writable: true, value: { href: originalHref } })
  })
})

describe('client — server-unavailable handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  it('503 dispatches server-unavailable event', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 503, body: { error: 'Service Unavailable' } }))

    const { apiFetch } = await import('../../src/api/client')

    const listener = vi.fn()
    window.addEventListener('server-unavailable', listener)

    const res = await apiFetch('/api/items')
    expect(res.status).toBe(503)

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ status: 503 })

    window.removeEventListener('server-unavailable', listener)
  })

  it('502 and 504 also dispatch server-unavailable event', async () => {
    const statuses = [502, 504]

    for (const status of statuses) {
      mockFetch.mockResolvedValue(mockResponse({ status, body: { error: 'Bad Gateway' } }))

      const { apiFetch } = await import('../../src/api/client')

      const listener = vi.fn()
      window.addEventListener('server-unavailable', listener)

      await apiFetch('/api/items')
      expect(listener).toHaveBeenCalled()
      const event = listener.mock.calls[0][0] as CustomEvent
      expect(event.detail.status).toBe(status)

      window.removeEventListener('server-unavailable', listener)
    }
  })

  it('network error dispatches server-unavailable with status 0', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))

    const { apiFetch } = await import('../../src/api/client')

    const listener = vi.fn()
    window.addEventListener('server-unavailable', listener)

    await expect(apiFetch('/api/items')).rejects.toThrow('Failed to fetch')

    expect(listener).toHaveBeenCalledOnce()
    const event = listener.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ status: 0 })

    window.removeEventListener('server-unavailable', listener)
  })

  it('500 does NOT dispatch server-unavailable (only 502/503/504)', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 500, body: { error: 'Internal Server Error' } }))

    const { apiFetch } = await import('../../src/api/client')

    const listener = vi.fn()
    window.addEventListener('server-unavailable', listener)

    const res = await apiFetch('/api/items')
    expect(res.status).toBe(500)

    expect(listener).not.toHaveBeenCalled()

    window.removeEventListener('server-unavailable', listener)
  })
})

describe('client — private state purge on identity change', () => {
  const deleted: string[] = []

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    deleted.length = 0
    vi.stubGlobal('caches', { delete: vi.fn(async (name: string) => { deleted.push(name); return true }) })
  })

  it('clearSessionState drops SW caches and per-user sessionStorage', async () => {
    const { clearSessionState } = await import('../../src/api/client')
    sessionStorage.setItem('discover-cache', '{"private":true}')
    deleted.length = 0

    clearSessionState()

    expect(deleted).toEqual(expect.arrayContaining(['api-cache', 'image-cache']))
    expect(sessionStorage.getItem('discover-cache')).toBeNull()
  })

  it('clearSessionState also drops any legacy stored token (upgrade path)', async () => {
    const { clearSessionState } = await import('../../src/api/client')
    localStorage.setItem('closet-auth-token', 'legacy-token')
    sessionStorage.setItem('closet-auth-token', 'legacy-token-2')

    clearSessionState()

    expect(localStorage.getItem('closet-auth-token')).toBeNull()
    expect(sessionStorage.getItem('closet-auth-token')).toBeNull()
  })
})

describe('client — getImageSrc', () => {
  it('never embeds the session token in image URLs', async () => {
    const { getImageSrc } = await import('../../src/api/client')
    expect(getImageSrc('images/items/a.jpg')).toBe('/images/items/a.jpg')
    expect(getImageSrc('/images/items/a.jpg')).toBe('/images/items/a.jpg')
  })
})
