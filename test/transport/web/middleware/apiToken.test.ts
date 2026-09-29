import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import { eq, ne } from 'drizzle-orm'
import { db } from '../../../../src/db/client.js'
import { users, apiTokens, sessions } from '../../../../src/db/schema.js'
import { createApiToken, revokeApiToken, createSession } from '../../../../src/db/queries.js'

const { requireApiToken, requireSession, requireTokensEnabled } = await import('../../../../src/transport/web/middleware.js')

// #315 — the default vitest env is HOSTED_MODE=true, but personal API tokens
// only authenticate when self-hosted (requireApiToken 401s every token in
// HOSTED_MODE). This file exercises token auth, so opt out by default; the
// "HOSTED_MODE gating" describe toggles the flag explicitly per test.
delete process.env.HOSTED_MODE

function createUser(email: string): string {
  const id = `m-${email.replace(/[^a-z0-9]/g, '')}`
  const existing = db.select().from(users).where(eq(users.id, id)).get()
  if (!existing) {
    db.insert(users).values({ id, email: email.toLowerCase(), createdAt: Date.now() }).run()
  }
  return id
}

function resetTables() {
  db.delete(apiTokens).run()
  db.delete(sessions).run()
  db.delete(users).where(ne(users.id, 'self')).run()
}

// Mini app that protects /protected with requireApiToken(requiredScopes).
function tokenApp(requiredScopes: Array<'read' | 'write' | 'ai'>) {
  const app = express()
  app.use(express.json())
  app.use('/protected', requireApiToken(requiredScopes), (_req, res) => {
    res.json({ ok: true, userId: _req.userId, scopes: _req.tokenScopes })
  })
  return app
}

// Mini app that protects /cookie-only with requireSession (cookie + bearer
// session). Used to prove an API token does NOT authenticate here.
function cookieApp() {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())
  app.use('/cookie-only', requireSession, (_req, res) => res.json({ ok: true }))
  return app
}

describe('requireApiToken — scope enforcement', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a read token calling a write-gated route → 403', async () => {
    const userId = createUser('scope-read@test.com')
    const { plaintext } = await createApiToken(userId, 'reader', ['read'])
    const res = await request(tokenApp(['write']))
      .get('/protected')
      .set('Authorization', `Bearer ${plaintext}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/scope/i)
  })

  it('a write token calling a write-gated route → 200', async () => {
    const userId = createUser('scope-write@test.com')
    const { plaintext } = await createApiToken(userId, 'writer', ['read', 'write'])
    const res = await request(tokenApp(['write']))
      .get('/protected')
      .set('Authorization', `Bearer ${plaintext}`)
    expect(res.status).toBe(200)
    expect(res.body.userId).toBe(userId)
    expect(res.body.scopes).toEqual(expect.arrayContaining(['read', 'write']))
  })

  it('an ai-gated route requires the ai scope', async () => {
    const userId = createUser('scope-ai@test.com')
    const { plaintext: readOnly } = await createApiToken(userId, 'ro', ['read'])
    const { plaintext: aiToken } = await createApiToken(userId, 'ai', ['read', 'ai'])

    const denied = await request(tokenApp(['ai'])).get('/protected').set('Authorization', `Bearer ${readOnly}`)
    expect(denied.status).toBe(403)

    const allowed = await request(tokenApp(['ai'])).get('/protected').set('Authorization', `Bearer ${aiToken}`)
    expect(allowed.status).toBe(200)
  })
})

describe('requireApiToken — revoked / expired / unknown tokens', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a revoked token → 401 on the next request', async () => {
    const userId = createUser('revoke@test.com')
    const { plaintext, token } = await createApiToken(userId, 'to-revoke', ['read'])
    // Before revoke: works.
    const before = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(before.status).toBe(200)
    // Revoke.
    expect(revokeApiToken(userId, token.id)).toBe(true)
    // After revoke: 401, with the SAME error as an unknown token.
    const after = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(after.status).toBe(401)
    const unknown = await request(tokenApp(['read'])).get('/protected').set('Authorization', 'Bearer vst_nope_nope_nope_nope_nope')
    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual(after.body)
  })

  it('an expired token → 401 (same error as unknown)', async () => {
    const userId = createUser('expire@test.com')
    const { plaintext, token } = await createApiToken(userId, 'expiring', ['read'])
    // Backdate expiry into the past directly.
    db.update(apiTokens).set({ expiresAt: Date.now() - 1000 }).where(eq(apiTokens.id, token.id)).run()
    const res = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(res.status).toBe(401)
  })

  it('no Authorization header → 401', async () => {
    const res = await request(tokenApp(['read'])).get('/protected')
    expect(res.status).toBe(401)
  })
})

describe('requireApiToken — cookies don’t work on token routes', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a closet-auth cookie is ignored (401, only Bearer is accepted)', async () => {
    const userId = createUser('cookie-reject@test.com')
    const { plaintext } = await createApiToken(userId, 't', ['read'])
    // Present the token as a cookie (not a Bearer header) — must NOT auth.
    const res = await request(tokenApp(['read']))
      .get('/protected')
      .set('Cookie', `closet-auth=${plaintext}`)
    expect(res.status).toBe(401)
  })

  it('a valid session cookie does not authenticate a token route', async () => {
    const userId = createUser('session-on-token@test.com')
    const session = createSession(userId)
    // Sanity: the same cookie DOES authenticate a cookie route.
    const ok = await request(cookieApp()).get('/cookie-only').set('Cookie', `closet-auth=${session.token}`)
    expect(ok.status).toBe(200)
    const app = express()
    app.use(cookieParser())
    app.use('/protected', requireApiToken(['read']), (_req, res) => res.json({ ok: true }))
    const res = await request(app).get('/protected').set('Cookie', `closet-auth=${session.token}`)
    expect(res.status).toBe(401)
  })
})

describe('HOSTED_MODE gating', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })
  afterEach(() => { delete process.env.HOSTED_MODE })

  it('requireTokensEnabled 404s in HOSTED_MODE and passes through otherwise', async () => {
    const app = express()
    app.use('/api/tokens', requireTokensEnabled, (_req, res) => res.json({ ok: true }))
    // #315 — the default vitest env is HOSTED_MODE=true, so opt out explicitly
    // to assert the self-host (pass-through) behaviour.
    delete process.env.HOSTED_MODE
    expect((await request(app).get('/api/tokens')).status).toBe(200)
    process.env.HOSTED_MODE = 'true'
    expect((await request(app).get('/api/tokens')).status).toBe(404)
  })

  it('a valid token stops working once HOSTED_MODE is on (same 401 as unknown)', async () => {
    const userId = createUser('hosted@test.com')
    const { plaintext } = await createApiToken(userId, 'pre-flip', ['read'])
    const before = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(before.status).toBe(200)
    process.env.HOSTED_MODE = 'true'
    const after = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(after.status).toBe(401)
    expect(after.body).toEqual({ error: 'Unauthorized' })
  })
})

describe('requireSession — tokens don’t work on cookie-only routes', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a personal API token presented as Bearer to a cookie-only route → 401', async () => {
    const userId = createUser('token-on-cookie@test.com')
    const { plaintext } = await createApiToken(userId, 't', ['read', 'write'])
    // requireSession looks the bearer up as a session token — it is NOT a
    // session token, so it must 401. Tokens are only valid on /mcp + /api/ha/*.
    const res = await request(cookieApp()).get('/cookie-only').set('Authorization', `Bearer ${plaintext}`)
    expect(res.status).toBe(401)
  })
})

describe('requireApiToken — lastUsedAt is bumped on success', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('updates lastUsedAt after a successful auth', async () => {
    const userId = createUser('touch@test.com')
    const { plaintext, token } = await createApiToken(userId, 'touch', ['read'])
    expect(token.lastUsedAt).toBeNull()
    const res = await request(tokenApp(['read'])).get('/protected').set('Authorization', `Bearer ${plaintext}`)
    expect(res.status).toBe(200)
    const row = db.select().from(apiTokens).where(eq(apiTokens.id, token.id)).get()!
    expect(row.lastUsedAt).not.toBeNull()
  })
})
