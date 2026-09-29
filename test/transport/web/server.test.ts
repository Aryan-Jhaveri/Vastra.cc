import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { quietHostedKeyHooks } from '../../helpers/quietHostedHooks.js'
import request from 'supertest'

// Mock all DB/tool imports before server loads
vi.mock('../../../src/db/client.js', () => ({
  db: {},
  DATA_DIR: '/tmp/closet-test',
  getSqlite: vi.fn(() => ({})),
}))

vi.mock('../../../src/db/reconcileMigrations.js', () => ({
  reconcileMigrations: vi.fn(),
}))

vi.mock('../../../src/storage/images.js', () => ({
  resolveImagePath: vi.fn((p: string) => `/tmp/closet-test/${p}`),
}))

vi.mock('../../../src/transport/web/routes/items.js', () => {
  const { Router } = require('express')
  const r = Router()
  r.get('/', (_req: any, res: any) => res.json([]))
  return { default: r }
})

vi.mock('../../../src/transport/web/routes/outfits.js', () => {
  const { Router } = require('express')
  const r = Router()
  r.get('/', (_req: any, res: any) => res.json([]))
  return { default: r }
})

vi.mock('../../../src/transport/web/routes/weather.js', () => {
  const { Router } = require('express')
  const r = Router()
  r.get('/', (_req: any, res: any) => res.json({}))
  return { default: r }
})

vi.mock('../../../src/transport/web/routes/userPhotos.js', () => {
  const { Router } = require('express')
  const r = Router()
  r.get('/', (_req: any, res: any) => res.json([]))
  return { default: r }
})

vi.mock('../../../src/transport/web/routes/tryon.js', () => {
  const { Router } = require('express')
  const r = Router()
  r.post('/', (_req: any, res: any) => res.json({}))
  return { default: r }
})

vi.mock('../../../src/transport/web/routes/jobs.js', () => {
  const { Router } = require('express')
  const r = Router()
  return { default: r }
})

vi.mock('../../../src/jobs/seed.js', () => ({
  seedDefaultJobs: vi.fn(),
}))

quietHostedKeyHooks()

vi.mock('../../../src/db/queries.js', () => ({
  getSetting: vi.fn().mockReturnValue(null),
  setSetting: vi.fn(),
  getSystemSetting: vi.fn().mockReturnValue(null),
  setSystemSetting: vi.fn(),
  getSessionByToken: vi.fn().mockReturnValue(undefined),
  getUserByEmail: vi.fn().mockReturnValue(undefined),
  createUser: vi.fn(),
  setUserAcceptedTerms: vi.fn(),
  createSession: vi.fn().mockReturnValue({ token: 'session-token-fixture' }),
  deleteSession: vi.fn(),
  getUserById: vi.fn().mockReturnValue(undefined),
  setUserName: vi.fn(),
  getUniqueCategories: vi.fn().mockReturnValue([]),
  getUniqueTags: vi.fn().mockReturnValue([]),
  getUniqueSubcategories: vi.fn().mockReturnValue([]),
  isUserAdmin: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../src/jobs/types/index.js', () => ({
  registerBuiltInJobTypes: vi.fn(),
}))

vi.mock('../../../src/jobs/scheduler.js', () => ({
  initScheduler: vi.fn(),
  addJobToScheduler: vi.fn(),
  removeJobFromScheduler: vi.fn(),
}))

describe('server auth integration', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.ADMIN_BEARER_FALLBACK = 'true'
  })

  afterEach(() => {
    delete process.env.ADMIN_BEARER_FALLBACK
  })

  it('returns 401 on protected routes without token', async () => {
    process.env.WEB_AUTH_PASSWORD = 'testpass'
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app).get('/api/items')
    expect(res.status).toBe(401)
  })

  it('returns 200 on protected routes with correct token', async () => {
    process.env.WEB_AUTH_PASSWORD = 'testpass'
    const { app } = await import('../../../src/transport/web/server.js')
    const { sessionToken } = await import('../../../src/transport/web/middleware.js')
    const res = await request(app)
      .get('/api/items')
      .set('Authorization', `Bearer ${sessionToken('testpass')}`)
    expect(res.status).toBe(200)
  })

  it('/api/auth sets cookie and returns ok', async () => {
    process.env.WEB_AUTH_PASSWORD = 'testpass'
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .post('/api/auth')
      .send({ password: 'testpass' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.headers['set-cookie']).toBeDefined()
  })

  it('/api/auth returns 401 for wrong password', async () => {
    process.env.WEB_AUTH_PASSWORD = 'testpass'
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .post('/api/auth')
      .send({ password: 'wrong' })
    expect(res.status).toBe(401)
  })

})

describe('admin-only password rotation (/api/settings/password)', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.ADMIN_BEARER_FALLBACK = 'true'
    process.env.WEB_AUTH_PASSWORD = 'testpass'
  })

  afterEach(async () => {
    delete process.env.ADMIN_BEARER_FALLBACK
    // Reset getSessionByToken to the file-level default so a per-test
    // mockReturnValue doesn't leak into the next test.
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue(undefined)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .post('/api/settings/password')
      .send({ current: 'testpass', newPassword: 'newsecret123' })
    expect(res.status).toBe(401)
  })

  it('rejects a non-admin (real-session) user with 403', async () => {
    const queries = await import('../../../src/db/queries.js')
    // Both attachSession (global) and requireSession (route-mounted) resolve
    // the token, so mockReturnValue (not Once) is required.
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'real-user', expiresAt: Date.now() + 100_000 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .post('/api/settings/password')
      .set('Authorization', 'Bearer real-user-token')
      .send({ current: 'testpass', newPassword: 'newsecret123' })
    expect(res.status).toBe(403)
  })

  it('lets the admin rotate the __system__ password row via setSystemSetting', async () => {
    const queries = await import('../../../src/db/queries.js')
    const { sessionToken } = await import('../../../src/transport/web/middleware.js')
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .post('/api/settings/password')
      .set('Authorization', `Bearer ${sessionToken('testpass')}`)
      .send({ current: 'testpass', newPassword: 'newsecret123' })
    expect(res.status).toBe(200)
    // Cookie-only rotation: the fresh session rides the httpOnly cookie, the
    // response body never carries the token (#295).
    expect(res.body.token).toBeUndefined()
    expect(res.headers['set-cookie']).toBeDefined()
    expect(queries.setSystemSetting).toHaveBeenCalledWith('password', 'newsecret123')
  })
})

describe('password hashing', () => {
  it('hashes and verifies correctly', async () => {
    const { hashPassword, verifyPassword } = await import('../../../src/auth/password.js')
    const hash = hashPassword('correctpw')
    expect(verifyPassword('correctpw', hash)).toBe(true)
    expect(verifyPassword('wrongpw', hash)).toBe(false)
  })

  it('produces different hashes for same password (salted)', async () => {
    const { hashPassword } = await import('../../../src/auth/password.js')
    const a = hashPassword('same')
    const b = hashPassword('same')
    expect(a).not.toBe(b)
  })
})

describe('request logger (#165)', () => {
  it('emits one formatted line with the resolved userId for an API GET', async () => {
    const express = (await import('express')).default
    const { requestLogger } = await import('../../../src/transport/web/logger.js')
    const lines: string[] = []
    const stream = { write: (s: string) => { lines.push(s); return true } }

    const app = express()
    app.use((req, _res, next) => { req.userId = 'user-123'; next() })
    app.use(requestLogger(stream))
    app.get('/api/items', (_req, res) => res.json({ ok: true }))

    const res = await request(app).get('/api/items')
    expect(res.status).toBe(200)
    // morgan writes on the response 'finished' event — wait a tick for it.
    await new Promise(r => setTimeout(r, 10))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/ GET \/api\/items 200 .* user=user-123/)
  })

  it('logs user=- when unauthenticated and skips /images and /assets', async () => {
    const express = (await import('express')).default
    const { requestLogger } = await import('../../../src/transport/web/logger.js')
    const lines: string[] = []
    const stream = { write: (s: string) => { lines.push(s); return true } }

    const app = express()
    app.use(requestLogger(stream))
    app.get('/api/auth/status', (_req, res) => res.json({}))
    app.get('/images/foo.jpg', (_req, res) => res.send('x'))
    app.get('/assets/app.js', (_req, res) => res.send('x'))

    await request(app).get('/images/foo.jpg')
    await request(app).get('/assets/app.js')
    await request(app).get('/api/auth/status')
    await new Promise(r => setTimeout(r, 10))

    // Only the /api/auth/status request is logged (assets skipped).
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('GET /api/auth/status')
    expect(lines[0]).toContain('user=-')
  })
})

describe('PATCH /api/auth/me', () => {
  beforeEach(() => { vi.resetModules() })

  afterEach(async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue(undefined)
    vi.mocked(queries.getUserById).mockReturnValue(undefined)
  })

  it('GET /api/auth/me returns name when user has one', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-1', expiresAt: Date.now() + 100_000 } as never)
    vi.mocked(queries.getUserById).mockReturnValue({ id: 'user-1', email: 'a@b.com', name: 'Alice', passwordHash: 'x', createdAt: 0 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer token-x')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-1', email: 'a@b.com', name: 'Alice', isAdmin: false })
  })

  it('GET /api/auth/me returns name: null when user has no name', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-1', expiresAt: Date.now() + 100_000 } as never)
    vi.mocked(queries.getUserById).mockReturnValue({ id: 'user-1', email: 'a@b.com', name: null, passwordHash: 'x', createdAt: 0 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer token-x')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-1', email: 'a@b.com', name: null, isAdmin: false })
  })

  it('PATCH /api/auth/me updates the name and returns it', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-1', expiresAt: Date.now() + 100_000 } as never)
    vi.mocked(queries.getUserById).mockReturnValue({ id: 'user-1', email: 'a@b.com', name: 'Bob', passwordHash: 'x', createdAt: 0 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', 'Bearer token-x')
      .send({ name: 'Bob' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-1', email: 'a@b.com', name: 'Bob' })
    expect(queries.setUserName).toHaveBeenCalledWith('user-1', 'Bob')
  })

  it('PATCH /api/auth/me rejects empty name', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-1', expiresAt: Date.now() + 100_000 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', 'Bearer token-x')
      .send({ name: '' })
    expect(res.status).toBe(400)
  })

  it('PATCH /api/auth/me rejects name that is just whitespace', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-1', expiresAt: Date.now() + 100_000 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    const res = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', 'Bearer token-x')
      .send({ name: '   ' })
    expect(res.status).toBe(400)
  })

  it('cross-user isolation: user A PATCH does not affect user B name', async () => {
    const queries = await import('../../../src/db/queries.js')
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-a', expiresAt: Date.now() + 100_000 } as never)
    const { app } = await import('../../../src/transport/web/server.js')
    // user A patches their name
    const resA = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', 'Bearer token-a')
      .send({ name: 'User A' })
    expect(resA.status).toBe(200)
    expect(queries.setUserName).toHaveBeenCalledWith('user-a', 'User A')

    // user B's session is different
    vi.mocked(queries.getSessionByToken).mockReturnValue({ userId: 'user-b', expiresAt: Date.now() + 100_000 } as never)
    const resB = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', 'Bearer token-b')
      .send({ name: 'User B' })
    expect(resB.status).toBe(200)
    expect(queries.setUserName).toHaveBeenCalledWith('user-b', 'User B')
  })
})
