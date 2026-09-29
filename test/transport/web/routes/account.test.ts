import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'

// The hosted pieces (OpenRouter key revoke before deletion, the billing
// checkout CSRF gate) are in test/hosted/routes/account.test.ts.

import { quietHostedKeyHooks } from '../../../helpers/quietHostedHooks.js'

quietHostedKeyHooks()

import { app } from '../../../../src/transport/web/server.js'
import { createUser, createSession, getUserById } from '../../../../src/db/queries.js'
import { DATA_DIR, db } from '../../../../src/db/client.js'
import { items } from '../../../../src/db/schema.js'
import { eq } from 'drizzle-orm'

function makeUser() {
  const user = createUser(`acct-${nanoid(8)}@test.com`, 'hash', 'Tester')
  const session = createSession(user.id)
  return { id: user.id, email: user.email, token: session.token }
}

function seedImageDir(userId: string): string {
  const dir = join(DATA_DIR, 'users', userId, 'images', 'items')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'x.jpg'), 'fake')
  return join(DATA_DIR, 'users', userId)
}

function seedItem(userId: string): string {
  const id = nanoid()
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category: 'top',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run()
  return id
}

const auth = (token: string) => (req: request.Test) =>
  req.set('Authorization', `Bearer ${token}`).set('Cookie', `closet-auth=${token}`)

describe('DELETE /api/account', () => {
  it('401 when unauthenticated', async () => {
    const res = await request(app).delete('/api/account')
    expect(res.status).toBe(401)
  })

  it('helmet sets CSP + X-Content-Type-Options headers', async () => {
    const res = await request(app).get('/api/auth/status')
    expect(res.status).toBe(200)
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('happy path: deletes the user + their image dir, leaves other users intact', async () => {
    const a = makeUser()
    const b = makeUser()
    const aDir = seedImageDir(a.id)
    const bDir = seedImageDir(b.id)
    const aItem = seedItem(a.id)
    const bItem = seedItem(b.id)

    const res = await auth(a.token)(request(app).delete('/api/account'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    // user A fully gone (rows + image dir)
    expect(getUserById(a.id)).toBeUndefined()
    expect(db.select().from(items).where(eq(items.id, aItem)).get()).toBeUndefined()
    expect(existsSync(aDir)).toBe(false)

    // cross-user isolation: B totally untouched
    expect(getUserById(b.id)).toBeDefined()
    expect(db.select().from(items).where(eq(items.id, bItem)).get()).toBeDefined()
    expect(existsSync(bDir)).toBe(true)

    rmSync(bDir, { recursive: true, force: true })
  })
})

describe('CSRF protection (cookie + X-Requested-With for mutations)', () => {
  it('POST with cookie-only (no CSRF header) returns 403', async () => {
    const u = makeUser()
    const res = await request(app)
      .post('/api/items/' + nanoid() + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
    expect(res.status).toBe(403)
  })

  it('POST with cookie + X-Requested-With succeeds', async () => {
    const u = makeUser()
    const itemId = seedItem(u.id)
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
      .set('X-Requested-With', 'vastra')
    expect(res.status).toBe(200)
  })

  it('POST with bearer-only succeeds (non-browser clients)', async () => {
    const u = makeUser()
    const itemId = seedItem(u.id)
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Authorization', `Bearer ${u.token}`)
    expect(res.status).toBe(200)
  })

  it('POST with cookie + CSRF header but cross-site Origin returns 403', async () => {
    const u = makeUser()
    const itemId = seedItem(u.id)
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
      .set('X-Requested-With', 'vastra')
      .set('Origin', 'https://evil.example.com')
    expect(res.status).toBe(403)
  })

  it('dev-proxy shape: Origin host ≠ Host (5173 origin vs :3000 host) → 403', async () => {
    // Documents the case from the #295 review: with changeOrigin:true the
    // Vite dev proxy rewrites Host to :3000 while the browser Origin stays
    // :5173. The server must reject that mismatch — the fix lives in
    // vite.config.ts (changeOrigin:false), NOT in a loosened check.
    const u = makeUser()
    const itemId = seedItem(u.id)
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
      .set('X-Requested-With', 'vastra')
      .set('Origin', 'http://localhost:5173')
      .set('Host', 'localhost:3000')
    expect(res.status).toBe(403)
  })

  it('POST with cookie + Authorization: Basic (no CSRF header) returns 403', async () => {
    // Browsers auto-attach cached HTTP Basic credentials. The header's mere
    // presence must NOT skip CSRF when the request actually authenticated
    // via the cookie (#295 review item 2).
    const u = makeUser()
    const itemId = seedItem(u.id)
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
      .set('Authorization', 'Basic eDp5')
    expect(res.status).toBe(403)
  })

  it('POST with cookie + CSRF header and matching Origin succeeds', async () => {
    const u = makeUser()
    const itemId = seedItem(u.id)
    const host = 'localhost:3000'
    const res = await request(app)
      .post('/api/items/' + itemId + '/worn')
      .set('Cookie', `closet-auth=${u.token}`)
      .set('X-Requested-With', 'vastra')
      .set('Origin', `http://${host}`)
      .set('Host', host)
    expect(res.status).toBe(200)
  })

  it('session token in ?token= query string is not accepted', async () => {
    const u = makeUser()
    const res = await request(app).get(`/api/items?token=${u.token}`)
    expect(res.status).toBe(401)
  })

  it('GET works with cookie-only (read path unaffected)', async () => {
    const u = makeUser()
    seedItem(u.id)
    const res = await request(app)
      .get('/api/items')
      .set('Cookie', `closet-auth=${u.token}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toBeDefined()
    expect(Array.isArray(res.body.items)).toBe(true)
  })
})
