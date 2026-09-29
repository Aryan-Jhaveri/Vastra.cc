import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ne, eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { users, oauthAccounts, sessions, userWallets, walletLedger, aiCalls } from '../../src/db/schema.js'
import { createUser } from '../../src/db/queries.js'

// Mutable refs the (hoisted) mock factory closes over.
const { exchange, cfg } = vi.hoisted(() => ({ exchange: vi.fn(), cfg: { configured: true } }))

// Mock only the Google network surface; keep the real signed-state logic so the
// CSRF state round-trip is exercised end-to-end.
vi.mock('../../src/auth/googleOAuth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/auth/googleOAuth.js')>()
  return {
    ...actual,
    isGoogleOAuthConfigured: () => cfg.configured,
    buildAuthUrl: (redirectUri: string, state: string) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCodeForProfile: exchange,
  }
})

import { googleStart, googleCallback } from '../../src/transport/web/routes/googleAuth.js'
import { createState, stateNonce } from '../../src/auth/googleOAuth.js'

interface MockRes {
  statusCode: number
  body: unknown
  redirectedTo: string | null
  cookies: Record<string, string>
  status: (c: number) => MockRes
  json: (b: unknown) => MockRes
  redirect: (url: string) => MockRes
  cookie: (name: string, value: string) => MockRes
  clearCookie: (name: string) => MockRes
  cleared: string[]
}

function mockRes(): MockRes {
  const res = { statusCode: 200, body: undefined, redirectedTo: null, cookies: {}, cleared: [] as string[] } as MockRes
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  res.redirect = (url) => { res.redirectedTo = url; return res }
  res.cookie = (name, value) => { res.cookies[name] = value; return res }
  res.clearCookie = (name) => { res.cleared.push(name); return res }
  return res
}

/** Like a real browser, the request carries the nonce cookie for its own state unless `cookies` says otherwise. */
function mockReq(query: Record<string, string> = {}, cookies?: Record<string, string>) {
  const nonce = stateNonce(query.state)
  return {
    query,
    headers: {},
    protocol: 'http',
    secure: false,
    cookies: cookies ?? (nonce ? { 'closet-oauth': nonce } : {}),
    get: (h: string) => (h.toLowerCase() === 'host' ? 'localhost:3000' : undefined),
  } as never
}

function userCount(): number {
  return db.select().from(users).where(ne(users.id, 'self')).all().length
}

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret'
  cfg.configured = true
  exchange.mockReset()
  db.delete(walletLedger).run()
  db.delete(aiCalls).run()
  db.delete(userWallets).run()
  db.delete(sessions).run()
  db.delete(oauthAccounts).run()
  db.delete(users).where(ne(users.id, 'self')).run()
  // Sign-ups default to closed on self-host (#315); cases below opt out.
  process.env.ALLOW_SIGNUPS = 'true'
})
afterEach(() => { delete process.env.ALLOW_SIGNUPS })

describe('googleStart', () => {
  it('redirects to the Google consent screen when configured', () => {
    const res = mockRes()
    googleStart(mockReq(), res as never)
    expect(res.redirectedTo).toContain('accounts.google.com')
    expect(res.redirectedTo).toContain('redirect_uri=')
    expect(res.redirectedTo).toContain(encodeURIComponent('http://localhost:3000/api/auth/google/callback'))
  })

  it('404s when Google OAuth is not configured', () => {
    cfg.configured = false
    const res = mockRes()
    googleStart(mockReq(), res as never)
    expect(res.statusCode).toBe(404)
  })
})

describe('googleCallback', () => {
  it('creates a new passwordless user and hands off via cookie only', async () => {
    exchange.mockResolvedValue({ sub: 'g-sub-1', email: 'new@gmail.com', emailVerified: true, name: 'New User' })
    const res = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: createState() }), res as never)

    // Cookie-only handoff: no #token= fragment, the session rides the
    // httpOnly cookie alone (#295).
    expect(res.redirectedTo).toBe('http://localhost:5173/?oauth=success')
    expect(res.cookies['closet-auth']).toBeTruthy()

    const user = db.select().from(users).where(eq(users.email, 'new@gmail.com')).get()
    expect(user).toBeTruthy()
    expect(user!.passwordHash).toBeNull()

    const link = db.select().from(oauthAccounts).where(eq(oauthAccounts.providerId, 'g-sub-1')).get()
    expect(link?.userId).toBe(user!.id)
    // The hosted signup grant: test/hosted/auth/googleOAuthGrant.test.ts.
  })

  it('links Google to an existing email account instead of creating a duplicate', async () => {
    const existing = createUser('person@gmail.com', null, 'Person')
    expect(userCount()).toBe(1)

    exchange.mockResolvedValue({ sub: 'g-sub-2', email: 'person@gmail.com', emailVerified: true, name: 'Person' })
    const res = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: createState() }), res as never)

    expect(userCount()).toBe(1)
    const link = db.select().from(oauthAccounts).where(eq(oauthAccounts.providerId, 'g-sub-2')).get()
    expect(link?.userId).toBe(existing.id)
    expect(res.redirectedTo).toContain('oauth=success')
  })

  it('a closed instance refuses a new Google account but still signs in an existing one (#315)', async () => {
    process.env.ALLOW_SIGNUPS = 'false'
    exchange.mockResolvedValue({ sub: 'g-sub-closed', email: 'stranger@gmail.com', emailVerified: true, name: 'S' })
    const refused = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: createState() }), refused as never)
    expect(refused.redirectedTo).toContain('oauth=error&reason=signups_closed')
    expect(refused.cookies['closet-auth']).toBeUndefined()
    expect(userCount()).toBe(0)

    createUser('owner@gmail.com', null, 'Owner')
    exchange.mockResolvedValue({ sub: 'g-sub-owner', email: 'owner@gmail.com', emailVerified: true, name: 'Owner' })
    const allowed = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: createState() }), allowed as never)
    expect(allowed.redirectedTo).toContain('oauth=success')
  })

  it('reuses the same user on repeat sign-in (same Google sub)', async () => {
    exchange.mockResolvedValue({ sub: 'g-sub-3', email: 'repeat@gmail.com', emailVerified: true, name: null })

    await googleCallback(mockReq({ code: 'code-1', state: createState() }), mockRes() as never)
    const firstUser = db.select().from(users).where(eq(users.email, 'repeat@gmail.com')).get()!

    await googleCallback(mockReq({ code: 'code-2', state: createState() }), mockRes() as never)

    expect(userCount()).toBe(1)
    const links = db.select().from(oauthAccounts).where(eq(oauthAccounts.providerId, 'g-sub-3')).all()
    expect(links.length).toBe(1)
    expect(links[0].userId).toBe(firstUser.id)
  })

  it('rejects a forged/invalid state without creating a session', async () => {
    exchange.mockResolvedValue({ sub: 'g-sub-x', email: 'evil@gmail.com', emailVerified: true, name: null })
    const res = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: 'forged.signature' }), res as never)

    expect(res.redirectedTo).toContain('oauth=error')
    expect(res.cookies['closet-auth']).toBeUndefined()
    expect(exchange).not.toHaveBeenCalled()
    expect(userCount()).toBe(0)
  })

  it('redirects to an error when Google returns an error param', async () => {
    const res = mockRes()
    await googleCallback(mockReq({ error: 'access_denied', state: createState() }), res as never)
    expect(res.redirectedTo).toContain('oauth=error')
    expect(exchange).not.toHaveBeenCalled()
  })

  it('refuses to link Google to an existing email when Google says email is not verified', async () => {
    const existing = createUser('person@gmail.com', 'hash', 'Person')
    expect(userCount()).toBe(1)

    exchange.mockResolvedValue({ sub: 'g-sub-attack', email: 'person@gmail.com', emailVerified: false, name: 'Attacker' })
    const res = mockRes()
    await googleCallback(mockReq({ code: 'auth-code', state: createState() }), res as never)

    expect(res.redirectedTo).toContain('oauth=error')
    expect(res.redirectedTo).toContain('reason=email_unverified')
    expect(db.select().from(oauthAccounts).where(eq(oauthAccounts.providerId, 'g-sub-attack')).all()).toHaveLength(0)
    expect(res.cookies['closet-auth']).toBeUndefined()
    expect(userCount()).toBe(1)
  })
})

describe('googleCallback — state bound to the browser (OSS audit)', () => {
  it('start sets an httpOnly nonce cookie that matches the state sent to Google', () => {
    const res = mockRes()
    googleStart(mockReq(), res as never)
    const state = new URL(res.redirectedTo!).searchParams.get('state')!
    expect(res.cookies['closet-oauth']).toBe(stateNonce(state))
  })

  it('a valid state + code from another browser (no or a different nonce cookie) is refused', async () => {
    exchange.mockResolvedValue({ sub: 'g-sub-csrf', email: 'attacker@gmail.com', emailVerified: true, name: 'A' })
    for (const cookies of [{}, { 'closet-oauth': 'someone-elses-nonce' }]) {
      const res = mockRes()
      await googleCallback(mockReq({ code: 'auth-code', state: createState() }, cookies), res as never)
      expect(res.redirectedTo).toContain('oauth=error&reason=state_mismatch')
      expect(res.cookies['closet-auth']).toBeUndefined()
      expect(res.cleared).toContain('closet-oauth')
    }
    expect(exchange).not.toHaveBeenCalled()
  })
})
