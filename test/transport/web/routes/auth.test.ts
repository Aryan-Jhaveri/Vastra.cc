import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import { eq, ne } from 'drizzle-orm'
import { db } from '../../../../src/db/client.js'
import { users, loginTokens, sessions } from '../../../../src/db/schema.js'
import { quietHostedKeyHooks } from '../../../helpers/quietHostedHooks.js'
import { hashSessionToken } from '../../../../src/db/queries.js'

// Network-touching side effects are stubbed. The real route fires the welcome
// email on first verify; we just assert it was called. The hosted OpenRouter
// key mint is covered in test/hosted/routes/auth.test.ts.
vi.mock('../../../../src/transport/web/email/index.js', () => ({
  sendSignInLinkEmail: vi.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: vi.fn().mockResolvedValue(undefined),
}))
quietHostedKeyHooks()

const { default: authRouter } = await import('../../../../src/transport/web/routes/auth.js')
const emailMod = await import('../../../../src/transport/web/email/index.js')

function appWithAuth() {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())
  app.use('/api/auth', authRouter)
  return app
}

function resetTables() {
  db.delete(sessions).run()
  db.delete(loginTokens).run()
  // Wipe all users except the seeded 'self' from test/setup.ts. Email-based
  // deletes are too brittle — they leave residue when test emails are renamed
  // (e.g. the @example.com → @gmail.com migration when the provider allowlist
  // was tightened).
  db.delete(users).where(ne(users.id, 'self')).run()
}

describe('POST /api/auth/send-link', () => {
  beforeEach(() => {
    resetTables()
    vi.clearAllMocks()
    delete process.env.ALLOWED_EMAIL_DOMAINS
    // Sign-ups default to closed on self-host (#315); these cases are about
    // an open instance. The closed cases live in their own describe below.
    process.env.ALLOW_SIGNUPS = 'true'
  })
  afterEach(() => { delete process.env.ALLOW_SIGNUPS })

  it('rejects malformed email with 400', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('rejects disposable / temp-mail domain with 403', async () => {
    // minitts.net is a real temp-mail provider that bypassed the legacy
    // disposable-email-domains blocklist — the provider allowlist closes it.
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'someone@minitts.net' })
    expect(res.status).toBe(403)
  })

  it('rejects mailinator (disposable) with 403', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'someone@mailinator.com' })
    expect(res.status).toBe(403)
  })

  it('rejects unknown / business domain with 403 (Workspace flows go via Google OAuth)', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'someone@some-business.com' })
    expect(res.status).toBe(403)
  })

  it('200 + creates user + creates token + returns generic ok', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'magic@gmail.com' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const user = db.select().from(users).where(eq(users.email, 'magic@gmail.com')).get()
    expect(user).toBeDefined()
    expect(user!.emailVerifiedAt).toBeNull()

    const tokenRow = db.select().from(loginTokens).where(eq(loginTokens.email, 'magic@gmail.com')).get()
    expect(tokenRow).toBeDefined()
    expect(tokenRow!.usedAt).toBeNull()
  })

  it('accepts provider variants (outlook.co.uk, yahoo.co.in, icloud.com, aol.com, yahoo.in, outlook.in, hotmail.in, live.in, yahoo.fi, yahoo.pl)', async () => {
    const emails = [
      'a@outlook.co.uk',
      'b@yahoo.co.in',
      'c@icloud.com',
      'd@aol.com',
      'e@yahoo.in',
      'f@outlook.in',
      'g@hotmail.in',
      'h@live.in',
      'i@yahoo.fi',
      'j@yahoo.pl',
    ]
    for (const email of emails) {
      const res = await request(appWithAuth())
        .post('/api/auth/send-link')
        .send({ email })
      expect(res.status, `expected 200 for ${email}`).toBe(200)
    }
  })

  it('rejects fake provider TLDs that match regex pattern (e.g. yahoo.notreal.tk)', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'x@yahoo.notreal.tk' })
    expect(res.status).toBe(403)
  })

  it('reuses existing user (no duplicate insert)', async () => {
    const createdAt = Date.now() - 60_000
    db.insert(users).values({ id: 'preexist', email: 'magic@gmail.com', createdAt }).run()

    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'magic@gmail.com' })
    expect(res.status).toBe(200)

    const all = db.select().from(users).where(eq(users.email, 'magic@gmail.com')).all()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe('preexist')
  })

  it('ALLOWED_EMAIL_DOMAINS short-circuits — blocks non-listed (overrides provider allowlist)', async () => {
    // Env override is exhaustive: even gmail.com is blocked when the env list doesn't include it.
    process.env.ALLOWED_EMAIL_DOMAINS = 'vastra.cc'
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'magic@gmail.com' })
    expect(res.status).toBe(403)
  })

  it('ALLOWED_EMAIL_DOMAINS short-circuits — allows listed (overrides provider allowlist)', async () => {
    // example.com is NOT in the provider allowlist; only the env override lets it through.
    process.env.ALLOWED_EMAIL_DOMAINS = 'example.com'
    const res = await request(appWithAuth())
      .post('/api/auth/send-link')
      .send({ email: 'magic@example.com' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/send-link on a closed instance (#315)', () => {
  const hosted = process.env.HOSTED_MODE
  beforeEach(() => {
    resetTables()
    vi.clearAllMocks()
    delete process.env.ALLOWED_EMAIL_DOMAINS
  })
  afterEach(() => {
    delete process.env.ALLOW_SIGNUPS
    if (hosted === undefined) delete process.env.HOSTED_MODE
    else process.env.HOSTED_MODE = hosted
  })

  it('self-host defaults to closed: an unknown email gets the same ok, but no user and no token', async () => {
    delete process.env.HOSTED_MODE
    delete process.env.ALLOW_SIGNUPS
    const res = await request(appWithAuth()).post('/api/auth/send-link').send({ email: 'stranger@gmail.com' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(db.select().from(users).where(eq(users.email, 'stranger@gmail.com')).get()).toBeUndefined()
    expect(db.select().from(loginTokens).where(eq(loginTokens.email, 'stranger@gmail.com')).get()).toBeUndefined()
    expect(emailMod.sendSignInLinkEmail).not.toHaveBeenCalled()
  })

  it('an existing account still gets a sign-in link while sign-ups are closed', async () => {
    process.env.ALLOW_SIGNUPS = 'false'
    db.insert(users).values({ id: 'u_closed_owner', email: 'owner@gmail.com', createdAt: Date.now() }).run()
    const res = await request(appWithAuth()).post('/api/auth/send-link').send({ email: 'owner@gmail.com' })
    expect(res.status).toBe(200)
    expect(db.select().from(loginTokens).where(eq(loginTokens.email, 'owner@gmail.com')).get()).toBeDefined()
  })

  it('ALLOW_SIGNUPS=false closes hosted mode too', async () => {
    process.env.HOSTED_MODE = 'true'
    process.env.ALLOW_SIGNUPS = 'false'
    await request(appWithAuth()).post('/api/auth/send-link').send({ email: 'late@gmail.com' })
    expect(db.select().from(users).where(eq(users.email, 'late@gmail.com')).get()).toBeUndefined()
  })
})

describe('GET /api/auth/verify-preview (scanner-safe)', () => {
  beforeEach(() => { resetTables() })

  it('returns valid + email for a fresh token', async () => {
    const createdAt = Date.now()
    db.insert(users).values({ id: 'u1', email: 'magic@gmail.com', createdAt }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-fresh',
      createdAt, expiresAt: createdAt + 60_000,
    }).run()

    const res = await request(appWithAuth()).get('/api/auth/verify-preview?token=tok-fresh')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ valid: true, email: 'magic@gmail.com', expired: false })
  })

  it('returns valid=false expired=true for an expired token', async () => {
    db.insert(users).values({ id: 'u1', email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-expired',
      createdAt: Date.now() - 60_000, expiresAt: Date.now() - 1,
    }).run()

    const res = await request(appWithAuth()).get('/api/auth/verify-preview?token=tok-expired')
    expect(res.body).toMatchObject({ valid: false, expired: true })
  })

  it('returns valid=false expired=false for a used token', async () => {
    db.insert(users).values({ id: 'u1', email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-used',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, usedAt: Date.now(),
    }).run()

    const res = await request(appWithAuth()).get('/api/auth/verify-preview?token=tok-used')
    expect(res.body).toMatchObject({ valid: false, expired: false })
  })

  it('returns valid=false for an unknown token (no leak)', async () => {
    const res = await request(appWithAuth()).get('/api/auth/verify-preview?token=does-not-exist')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ valid: false, expired: false })
  })

  it('DOES NOT consume the token across multiple GETs (scanner safety)', async () => {
    db.insert(users).values({ id: 'u1', email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-safe',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    for (let i = 0; i < 5; i++) {
      const res = await request(appWithAuth()).get('/api/auth/verify-preview?token=tok-safe')
      expect(res.body.valid).toBe(true)
    }
    const row = db.select().from(loginTokens).where(eq(loginTokens.token, 'tok-safe')).get()
    expect(row!.usedAt).toBeNull()
  })
})

describe('POST /api/auth/verify-confirm', () => {
  beforeEach(() => {
    resetTables()
    vi.clearAllMocks()
  })

  it('400 when token missing', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({})
    expect(res.status).toBe(400)
  })

  it('400 when token unknown', async () => {
    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'no-such' })
    expect(res.status).toBe(400)
  })

  it('400 when token expired', async () => {
    db.insert(users).values({ id: 'u1', email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-exp',
      createdAt: Date.now() - 60_000, expiresAt: Date.now() - 1,
    }).run()
    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-exp' })
    expect(res.status).toBe(400)
  })

  it('first confirm: marks token used, sets emailVerifiedAt, creates session, fires side-effects', async () => {
    const userId = 'u-first'
    db.insert(users).values({ id: userId, email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-first',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-first' })
    expect(res.status).toBe(200)
    // Cookie-only session: the token rides the httpOnly cookie and never
    // appears in the response body (#295).
    expect(res.body.ok).toBe(true)
    expect(res.body.token).toBeUndefined()
    expect(res.headers['set-cookie']).toBeDefined()
    expect(res.body.user).toMatchObject({ id: userId, email: 'magic@gmail.com' })

    const tokenRow = db.select().from(loginTokens).where(eq(loginTokens.token, 'tok-first')).get()
    expect(tokenRow!.usedAt).not.toBeNull()

    const user = db.select().from(users).where(eq(users.id, userId)).get()
    expect(user!.emailVerifiedAt).not.toBeNull()

    const cookieHeader = String(res.headers['set-cookie'] ?? '')
    const sessionTokenValue = cookieHeader.match(/closet-auth=([^;]+)/)?.[1] ?? ''
    const session = db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(sessionTokenValue))).get()
    expect(session).toBeDefined()
    expect(session!.userId).toBe(userId)
    // #360 — only the hash is stored; the cookie value appears nowhere in the table.
    expect(JSON.stringify(db.select().from(sessions).all())).not.toContain(sessionTokenValue)

    expect(emailMod.sendWelcomeEmail).toHaveBeenCalledTimes(1)
  })

  it('first confirm when self-hosted: the welcome email fires (#315)', async () => {
    const userId = 'u-selfhost'
    db.insert(users).values({ id: userId, email: 'selfhost@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'selfhost@gmail.com', token: 'tok-selfhost',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const wasHosted = process.env.HOSTED_MODE
    delete process.env.HOSTED_MODE
    try {
      const res = await request(appWithAuth())
        .post('/api/auth/verify-confirm')
        .send({ token: 'tok-selfhost' })
      expect(res.status).toBe(200)
      expect(emailMod.sendWelcomeEmail).toHaveBeenCalledTimes(1)
    } finally {
      if (wasHosted === undefined) delete process.env.HOSTED_MODE
      else process.env.HOSTED_MODE = wasHosted
    }
  })

  it('second confirm of the same token: 400 (replay protection)', async () => {
    db.insert(users).values({ id: 'u-replay', email: 'magic@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'magic@gmail.com', token: 'tok-replay',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const first = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-replay' })
    expect(first.status).toBe(200)

    const second = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-replay' })
    expect(second.status).toBe(400)
  })

  it('remember=true (default) bakes a persistent cookie (Max-Age set) — #295', async () => {
    db.insert(users).values({ id: 'u-remember', email: 'remember@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'remember@gmail.com', token: 'tok-remember',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-remember' })
    expect(res.status).toBe(200)
    const cookieHeader = String(res.headers['set-cookie'] ?? '')
    expect(cookieHeader).toMatch(/closet-auth=/)
    expect(cookieHeader).toMatch(/Max-Age=/)
    expect(cookieHeader).toMatch(/HttpOnly/i)
  })

  it('remember=false bakes a session cookie (no Max-Age) — #295', async () => {
    db.insert(users).values({ id: 'u-noremember', email: 'noremember@gmail.com', createdAt: Date.now() }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'noremember@gmail.com', token: 'tok-noremember',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-noremember', remember: false })
    expect(res.status).toBe(200)
    const cookieHeader = String(res.headers['set-cookie'] ?? '')
    expect(cookieHeader).toMatch(/closet-auth=/)
    expect(cookieHeader).not.toMatch(/Max-Age=/)
    expect(cookieHeader).toMatch(/HttpOnly/i)
  })

  it('subsequent confirm for already-verified user does NOT re-fire welcome', async () => {
    const userId = 'u-already'
    db.insert(users).values({
      id: userId, email: 'already@gmail.com',
      createdAt: Date.now(), emailVerifiedAt: Date.now() - 60_000,
    }).run()
    db.insert(loginTokens).values({
      id: 't1', email: 'already@gmail.com', token: 'tok-already',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }).run()

    const res = await request(appWithAuth())
      .post('/api/auth/verify-confirm')
      .send({ token: 'tok-already' })
    expect(res.status).toBe(200)

    expect(emailMod.sendWelcomeEmail).not.toHaveBeenCalled()
  })
})
