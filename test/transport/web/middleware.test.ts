import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

function tok(password: string): string {
  return createHmac('sha256', 'closet-session-v1').update(password).digest('hex')
}

// Mock DB queries so middleware doesn't need a real SQLite connection
vi.mock('../../../src/db/queries.js', () => ({
  getSetting: vi.fn().mockReturnValue(null),
  setSetting: vi.fn(),
  // getPassword now reads the reserved __system__ row via getSystemSetting (#68).
  getSystemSetting: vi.fn().mockReturnValue(null), // no DB password; falls back to env var
  setSystemSetting: vi.fn(),
  getSessionByToken: vi.fn().mockReturnValue(undefined),
  isUserAdmin: vi.fn().mockReturnValue(false),
  // The legacy shared 'self' row exists unless a test says otherwise (#315).
  getUserById: vi.fn((id: string) => (id === 'self' ? { id: 'self' } : undefined)),
}))

// Must set env before importing the module under test
const originalEnv = process.env

describe('authGuard middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeReqRes(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
    const req = {
      headers,
      cookies,
    } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  it('allows through when no WEB_AUTH_PASSWORD configured', async () => {
    delete process.env.WEB_AUTH_PASSWORD
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes()
    authGuard(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 401 when no token provided', async () => {
    process.env.WEB_AUTH_PASSWORD = 'secret'
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes()
    authGuard(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 for wrong Bearer token', async () => {
    process.env.WEB_AUTH_PASSWORD = 'secret'
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer wrong' })
    authGuard(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows through with correct Bearer token', async () => {
    process.env.WEB_AUTH_PASSWORD = 'secret'
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: `Bearer ${tok('secret')}` })
    authGuard(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('allows through with correct cookie', async () => {
    process.env.WEB_AUTH_PASSWORD = 'secret'
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({}, { 'closet-auth': tok('secret') })
    authGuard(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 401 for wrong cookie value', async () => {
    process.env.WEB_AUTH_PASSWORD = 'secret'
    const { authGuard } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({}, { 'closet-auth': 'bad' })
    authGuard(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requireAdmin middleware', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeReqRes(userId?: string) {
    const req = { userId } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  it('passes for legacy "self" identity', async () => {
    const { requireAdmin } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes('self')
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('passes for real userId with is_admin=true', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(true)
    const { requireAdmin } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes('user-123')
    requireAdmin(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 403 for real userId with is_admin=false', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(false)
    const { requireAdmin } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes('user-123')
    requireAdmin(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 403 when no userId is set', async () => {
    const { requireAdmin } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes(undefined)
    requireAdmin(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('admin → self session rewrite', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeReqRes(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
    const req = { headers, cookies } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  it('requireSession rewrites admin session userId to "self"', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue({
      userId: 'admin-123',
      expiresAt: Date.now() + 60_000,
    } as any)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(true)
    const { requireSession } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('self')
  })

  it('a fresh self-hosted instance (no legacy "self" row): the admin stays their own user (#315)', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue({
      userId: 'admin-fresh',
      expiresAt: Date.now() + 60_000,
    } as any)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(true)
    vi.mocked(mockQueries.getUserById).mockReturnValue(undefined)
    try {
      const { requireSession, requireAdmin } = await import('../../../src/transport/web/middleware.js')
      const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
      requireSession(req, res, next)
      expect((req as any).userId).toBe('admin-fresh')
      // Admin routes still let them in by their own id.
      const gate = makeReqRes()
      ;(gate.req as any).userId = 'admin-fresh'
      requireAdmin(gate.req, gate.res, gate.next)
      expect(gate.next).toHaveBeenCalledOnce()
    } finally {
      vi.mocked(mockQueries.getUserById).mockImplementation((id: string) => (id === 'self' ? { id: 'self' } : undefined) as any)
    }
  })

  it('requireSession preserves non-admin userId', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue({
      userId: 'user-456',
      expiresAt: Date.now() + 60_000,
    } as any)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(false)
    const { requireSession } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('user-456')
  })
})

describe('authVia — CSRF bypass proof (#295 review item 2)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.ADMIN_BEARER_FALLBACK
    delete process.env.WEB_AUTH_PASSWORD
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeReqRes(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
    const req = { headers, cookies } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  function validSession() {
    return { userId: 'user-1', expiresAt: Date.now() + 60_000 } as any
  }

  // The vi.mock factory's fns are instantiated ONCE per file and the root
  // suite runs with clearMocks:false — mockReturnValue set by another
  // describe (e.g. isUserAdmin=true in the admin-rewrite tests) leaks into
  // these under --sequence.shuffle. Every test here re-pins both mocks.
  async function pinnedQueries() {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue(undefined)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(false)
    return mockQueries
  }

  it('session presented via Bearer header → authVia=bearer', async () => {
    const mockQueries = await pinnedQueries()
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue(validSession())
    const { requireSession } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).authVia).toBe('bearer')
  })

  it('session presented via cookie → authVia=cookie', async () => {
    const mockQueries = await pinnedQueries()
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue(validSession())
    const { requireSession } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({}, { 'closet-auth': 'valid-session-token' })
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).authVia).toBe('cookie')
  })

  it('Authorization header with a non-Bearer scheme + cookie → authVia=cookie (Basic must not bypass CSRF)', async () => {
    const mockQueries = await pinnedQueries()
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue(validSession())
    const { requireSession } = await import('../../../src/transport/web/middleware.js')
    // Browsers auto-attach cached HTTP Basic credentials — the request still
    // authenticates through the cookie, so the CSRF middleware must see it
    // as a cookie request.
    const { req, res, next } = makeReqRes(
      { authorization: 'Basic eDp5' },
      { 'closet-auth': 'valid-session-token' },
    )
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('user-1')
    expect((req as any).authVia).toBe('cookie')
  })

  it('admin fallback bearer (ADMIN_BEARER_FALLBACK) → authVia=bearer', async () => {
    process.env.ADMIN_BEARER_FALLBACK = 'true'
    process.env.WEB_AUTH_PASSWORD = 'admin-secret'
    await pinnedQueries()
    const { requireSession, sessionToken } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({
      authorization: `Bearer ${sessionToken('admin-secret')}`,
    })
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('self')
    expect((req as any).authVia).toBe('bearer')
  })

  it('admin fallback token delivered via COOKIE (POST /api/auth sign-in) → authVia=cookie — no CSRF bypass', async () => {
    // The admin browser form stores the password-derived token as a cookie.
    // That is a cookie session: without the CSRF proof header its mutations
    // must 403. Found live during the dev-proxy review check — marking the
    // fallback 'bearer' unconditionally let every admin-cookie mutation
    // skip CSRF (#295 review).
    process.env.ADMIN_BEARER_FALLBACK = 'true'
    process.env.WEB_AUTH_PASSWORD = 'admin-secret'
    await pinnedQueries()
    const { requireSession, sessionToken } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes(
      {},
      { 'closet-auth': sessionToken('admin-secret') },
    )
    requireSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('self')
    expect((req as any).authVia).toBe('cookie')
  })
})

describe('admin → self session rewrite (requireBearer / attachSession)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeReqRes(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
    const req = { headers, cookies } as unknown as Request
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  it('requireBearer rewrites admin session userId to "self" and marks authVia=bearer', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue({
      userId: 'admin-123',
      expiresAt: Date.now() + 60_000,
    } as any)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(true)
    const { requireBearer } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
    requireBearer(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('self')
    expect((req as any).authVia).toBe('bearer')
  })

  it('attachSession rewrites admin session userId to "self" (non-rejecting resolver)', async () => {
    const mockQueries = await import('../../../src/db/queries.js')
    vi.mocked(mockQueries.getSessionByToken).mockReturnValue({
      userId: 'admin-123',
      expiresAt: Date.now() + 60_000,
    } as any)
    vi.mocked(mockQueries.isUserAdmin).mockReturnValue(true)
    const { attachSession } = await import('../../../src/transport/web/middleware.js')
    const { req, res, next } = makeReqRes({ authorization: 'Bearer valid-session-token' })
    attachSession(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).userId).toBe('self')
    expect((req as any).authVia).toBe('bearer')
  })
})
