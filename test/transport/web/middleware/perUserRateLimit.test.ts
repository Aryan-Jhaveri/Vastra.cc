import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { perUserRateLimit } from '../../../../src/transport/web/middleware/perUserRateLimit.js'

function appWithAuth(userId: string) {
  const app = express()
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  const limiter = perUserRateLimit(60_000, 6)
  app.post('/api/test', limiter, (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

describe('perUserRateLimit', () => {
  beforeEach(() => {
    delete process.env.VITEST
  })

  it('allows up to max requests per window for the same userId', async () => {
    const app = appWithAuth('user-a')
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/test')
      expect(res.status).toBe(200)
    }
  })

  it('returns 429 on the (max+1)th request for the same userId', async () => {
    const app = appWithAuth('user-a')
    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/test')
    }
    const res = await request(app).post('/api/test')
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate_limited')
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0)
    // Clients (bulk Add Item) honour the standard header, not just the body.
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(res.headers['ratelimit-remaining']).toBe('0')
  })

  it('does NOT rate-limit a different userId (per-user keying)', async () => {
    const appA = appWithAuth('user-a')
    for (let i = 0; i < 6; i++) {
      await request(appA).post('/api/test')
    }
    const resA = await request(appA).post('/api/test')
    expect(resA.status).toBe(429)

    const appB = appWithAuth('user-b')
    const resB = await request(appB).post('/api/test')
    expect(resB.status).toBe(200)
  })

  it('falls back to ip: prefix when no userId is set', async () => {
    const app = express()
    const limiter = perUserRateLimit(60_000, 6)
    app.post('/api/test', limiter, (_req, res) => {
      res.json({ ok: true })
    })
    for (let i = 0; i < 6; i++) {
      await request(app).post('/api/test')
    }
    const res = await request(app).post('/api/test')
    expect(res.status).toBe(429)
  })
})
