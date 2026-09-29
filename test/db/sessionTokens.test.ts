import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, getSqlite } from '../../src/db/client.js'
import { sessions, users } from '../../src/db/schema.js'
import { createSession, deleteSession, deleteUserSessions, getSessionByToken, hashSessionToken } from '../../src/db/queries.js'
import { requireSession } from '../../src/transport/web/middleware.js'

// #360 — sessions store a SHA-256 of the token, never the token.

const created: string[] = []
function user(): string {
  const id = `sess_${nanoid(8)}`
  db.insert(users).values({ id, email: `${id}@test.local`, createdAt: Date.now() }).run()
  created.push(id)
  return id
}

afterEach(() => {
  for (const id of created.splice(0)) db.delete(users).where(eq(users.id, id)).run()
})

function app() {
  const a = express()
  a.use(cookieParser())
  a.get('/me', requireSession, (req, res) => { res.json({ userId: req.userId }) })
  return a
}

describe('hashed session tokens', () => {
  it('stores only the SHA-256 of the token; the raw token is nowhere in the table', () => {
    const u = user()
    const session = createSession(u)
    expect(session.token.length).toBeGreaterThanOrEqual(40)
    const row = db.select().from(sessions).where(eq(sessions.id, session.id)).get()!
    expect(row.tokenHash).toBe(hashSessionToken(session.token))
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(getSqlite().prepare('SELECT * FROM sessions WHERE user_id = ?').all(u))).not.toContain(session.token)
    const columns = (getSqlite().prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(columns).not.toContain('token')
  })

  it('the presented token authenticates; the stored hash does not', async () => {
    const u = user()
    const { token, tokenHash } = createSession(u)
    expect(getSessionByToken(token)?.userId).toBe(u)
    expect(getSessionByToken(tokenHash)).toBeUndefined()

    const ok = await request(app()).get('/me').set('Cookie', `closet-auth=${token}`)
    expect(ok.status).toBe(200)
    expect(ok.body.userId).toBe(u)
    const stolen = await request(app()).get('/me').set('Cookie', `closet-auth=${tokenHash}`)
    expect(stolen.status).toBe(401)
    const bearer = await request(app()).get('/me').set('Authorization', `Bearer ${tokenHash}`)
    expect(bearer.status).toBe(401)
  })

  it('logout and expiry still end a session', async () => {
    const u = user()
    const live = createSession(u)
    deleteSession(live.token)
    expect(getSessionByToken(live.token)).toBeUndefined()
    expect((await request(app()).get('/me').set('Cookie', `closet-auth=${live.token}`)).status).toBe(401)

    const expired = createSession(u, -1)
    expect((await request(app()).get('/me').set('Cookie', `closet-auth=${expired.token}`)).status).toBe(401)
  })

  it("a session resolves only to its own user, and deleting one user's sessions leaves others", () => {
    const a = user()
    const b = user()
    const sa = createSession(a)
    const sb = createSession(b)
    expect(getSessionByToken(sa.token)?.userId).toBe(a)
    expect(getSessionByToken(sb.token)?.userId).toBe(b)
    deleteUserSessions(a)
    expect(getSessionByToken(sa.token)).toBeUndefined()
    expect(getSessionByToken(sb.token)?.userId).toBe(b)
  })
})
