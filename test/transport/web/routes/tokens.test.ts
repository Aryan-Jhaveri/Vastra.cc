import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq, ne } from 'drizzle-orm'
import { db } from '../../../../src/db/client.js'
import { users, apiTokens } from '../../../../src/db/schema.js'
import { createApiToken, listApiTokens } from '../../../../src/db/queries.js'

// The tokens router is cookie-session-managed; in tests we stub the session
// middleware by setting req.userId directly (mirroring settings.test.ts). The
// CSRF proof is bypassed by not mounting requireCsrfForMutations — the router
// itself never inspects the CSRF header.

function makeApp(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  app.use('/api/tokens', tokensRouter)
  return app
}

// Import after env is set up (db client reads CLOSET_DATA_DIR at first use).
const tokensRouter = (await import('../../../../src/transport/web/routes/tokens.js')).default

function createUser(email: string): string {
  const id = `u-${email.replace(/[^a-z0-9]/g, '')}`
  const existing = db.select().from(users).where(eq(users.id, id)).get()
  if (!existing) {
    db.insert(users).values({ id, email: email.toLowerCase(), createdAt: Date.now() }).run()
  }
  return id
}

function resetTokens() {
  db.delete(apiTokens).run()
  db.delete(users).where(ne(users.id, 'self')).run()
}

describe('POST /api/tokens — create', () => {
  beforeEach(() => { resetTokens(); vi.clearAllMocks() })

  it('returns the plaintext once with Cache-Control: no-store', async () => {
    const userId = createUser('alice@test.com')
    const res = await request(makeApp(userId))
      .post('/api/tokens')
      .send({ name: 'My script', scopes: ['read', 'write'] })

    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toMatch(/no-store/i)
    expect(typeof res.body.plaintext).toBe('string')
    expect(res.body.plaintext).toMatch(/^vst_/)
    expect(res.body.token).toBeDefined()
    expect(res.body.token.name).toBe('My script')
    expect(res.body.token.prefix).toBe(res.body.plaintext.slice(0, 10))
  })

  it('does not store the plaintext and does not return it on list', async () => {
    const userId = createUser('alice@test.com')
    const created = await createApiToken(userId, 'Secret', ['read'])
    // The stored hash is NOT the plaintext.
    const row = db.select().from(apiTokens).where(eq(apiTokens.id, created.token.id)).get()!
    expect(row.tokenHash).not.toBe(created.plaintext)
    expect(row.tokenHash).toHaveLength(64) // sha256 hex

    const res = await request(makeApp(userId)).get('/api/tokens')
    expect(res.status).toBe(200)
    const list = res.body as Array<{ name: string; prefix: string }>
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list[0])).not.toContain(created.plaintext)
    expect(list[0].prefix).toBe(created.token.prefix)
  })

  it('always includes the read scope', async () => {
    const userId = createUser('alice@test.com')
    const res = await request(makeApp(userId))
      .post('/api/tokens')
      .send({ name: 'AI only', scopes: ['ai'] })
    expect(res.status).toBe(200)
    expect(res.body.token.scopes).toEqual(expect.arrayContaining(['read', 'ai']))
    expect(res.body.token.scopes).toContain('read')
  })

  it('rejects an invalid scope with 400', async () => {
    const userId = createUser('alice@test.com')
    const res = await request(makeApp(userId))
      .post('/api/tokens')
      .send({ name: 'Bad', scopes: ['read', 'admin'] })
    expect(res.status).toBe(400)
  })

  it('rejects an empty name with 400', async () => {
    const userId = createUser('alice@test.com')
    const res = await request(makeApp(userId))
      .post('/api/tokens')
      .send({ name: '   ', scopes: ['read'] })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/tokens — list (cross-user isolation)', () => {
  beforeEach(() => { resetTokens(); vi.clearAllMocks() })

  it('only returns the calling user’s tokens', async () => {
    const alice = createUser('alice@test.com')
    const bob = createUser('bob@test.com')
    await createApiToken(alice, 'alice-1', ['read'])
    await createApiToken(alice, 'alice-2', ['read', 'write'])
    await createApiToken(bob, 'bob-1', ['read'])

    const aliceList = listApiTokens(alice)
    expect(aliceList).toHaveLength(2)
    expect(aliceList.every(t => t.name.startsWith('alice'))).toBe(true)

    const bobList = listApiTokens(bob)
    expect(bobList).toHaveLength(1)
    expect(bobList[0].name).toBe('bob-1')
  })
})

describe('DELETE /api/tokens/:id — revoke', () => {
  beforeEach(() => { resetTokens(); vi.clearAllMocks() })

  it('revokes the caller’s own token', async () => {
    const userId = createUser('alice@test.com')
    const { token } = await createApiToken(userId, 'revoke-me', ['read'])
    const res = await request(makeApp(userId)).delete(`/api/tokens/${token.id}`)
    expect(res.status).toBe(200)
    const list = listApiTokens(userId)
    expect(list[0].revokedAt).not.toBeNull()
  })

  it('GET /api/tokens hides revoked and expired tokens (rows kept for audit)', async () => {
    const userId = createUser('alice@test.com')
    const { token: active } = await createApiToken(userId, 'active', ['read'])
    const { token: revoked } = await createApiToken(userId, 'revoked', ['read'])
    const { token: expired } = await createApiToken(userId, 'expired', ['read'])
    db.update(apiTokens).set({ expiresAt: Date.now() - 1000 }).where(eq(apiTokens.id, expired.id)).run()
    const app = makeApp(userId)
    expect((await request(app).delete(`/api/tokens/${revoked.id}`)).status).toBe(200)

    const res = await request(app).get('/api/tokens')
    expect(res.status).toBe(200)
    expect((res.body as Array<{ id: string }>).map(t => t.id)).toEqual([active.id])
    expect(listApiTokens(userId)).toHaveLength(3)
  })

  it('cannot revoke another user’s token (404, no cross-user delete)', async () => {
    const alice = createUser('alice@test.com')
    const bob = createUser('bob@test.com')
    const { token } = await createApiToken(alice, 'alice-only', ['read'])
    const res = await request(makeApp(bob)).delete(`/api/tokens/${token.id}`)
    expect(res.status).toBe(404)
    // Alice’s token is still active.
    const list = listApiTokens(alice)
    expect(list[0].revokedAt).toBeNull()
  })
})
