import type { Request, Response } from 'express'
import { timingSafeEqual } from 'crypto'
import {
  isGoogleOAuthConfigured,
  buildAuthUrl,
  exchangeCodeForProfile,
  createState,
  verifyState,
  stateNonce,
} from '../../../auth/googleOAuth.js'
import {
  getOAuthAccount,
  linkOAuthAccount,
  getUserByEmail,
  getUserById,
  createUser,
  createSession,
} from '../../../db/queries.js'
import type { users as usersTable } from '../../../db/schema.js'
import { cookieOpts } from '../cookies.js'
import { signupsOpen } from '../../../auth/signups.js'

const PROVIDER = 'google'

class SignupsClosedError extends Error {}

// Binds an OAuth round-trip to the browser that started it (see stateNonce).
const STATE_COOKIE = 'closet-oauth'
const STATE_COOKIE_MS = 10 * 60 * 1000

function stateCookieOpts(req: Request, withAge = true) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  return {
    httpOnly: true, sameSite: 'lax' as const, secure, path: '/api/auth/google',
    ...(withAge ? { maxAge: STATE_COOKIE_MS } : {}),
  }
}

function sameNonce(a: unknown, b: string | null): boolean {
  if (typeof a !== 'string' || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

type User = typeof usersTable.$inferSelect

function reqProto(req: Request): string {
  const fwd = req.headers['x-forwarded-proto']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.protocol
}

/**
 * Where Google sends the browser after consent. Must EXACTLY match a redirect
 * URI registered in the GCP OAuth client. Derived from the request host so it
 * works in dev (localhost:3000) and prod without config, with an env override.
 */
function redirectUri(req: Request): string {
  if (process.env.GOOGLE_OAUTH_REDIRECT_URI) return process.env.GOOGLE_OAUTH_REDIRECT_URI
  return `${reqProto(req)}://${req.get('host')}/api/auth/google/callback`
}

/** Where to send the user (the SPA) after we've created their session. */
function frontendBase(req: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '')
  // The callback is a top-level navigation from Google with no Origin header,
  // so we can't trust req.headers.origin here. In dev the SPA is served by Vite.
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:5173'
  return `${reqProto(req)}://${req.get('host')}`
}

/** GET /api/auth/google/start — redirect to Google's consent screen. */
export function googleStart(req: Request, res: Response): void {
  if (!isGoogleOAuthConfigured()) {
    res.status(404).json({ error: 'Google sign-in is not configured' })
    return
  }
  const state = createState()
  res.cookie(STATE_COOKIE, stateNonce(state), stateCookieOpts(req))
  res.redirect(buildAuthUrl(redirectUri(req), state))
}

/**
 * Find an existing user for this Google profile, or create one. Resolution
 * order: (1) existing oauth_accounts link → (2) existing user with same email
 * (link it, **only if email is verified by Google**) → (3) brand-new user.
 */
function resolveUser(profile: { sub: string; email: string; name: string | null; emailVerified: boolean }): User {
  const linked = getOAuthAccount(PROVIDER, profile.sub)
  if (linked) {
    const existing = getUserById(linked.userId)
    if (existing) return existing
  }

  const byEmail = getUserByEmail(profile.email)
  if (byEmail) {
    if (!profile.emailVerified) {
      throw new Error('Cannot link Google account — email not verified by Google')
    }
    linkOAuthAccount(byEmail.id, PROVIDER, profile.sub)
    return byEmail
  }

  if (!signupsOpen()) throw new SignupsClosedError()
  const created = createUser(profile.email, null, profile.name ?? undefined)
  linkOAuthAccount(created.id, PROVIDER, profile.sub)
  return created
}

/** GET /api/auth/google/callback — exchange code, create session, hand off to SPA. */
export async function googleCallback(req: Request, res: Response): Promise<void> {
  const base = frontendBase(req)

  if (!isGoogleOAuthConfigured()) {
    res.redirect(`${base}/?oauth=error`)
    return
  }

  const { code, state, error } = req.query
  if (error === 'access_denied') {
    res.redirect(`${base}/?oauth=error&reason=denied`)
    return
  }
  if (error || typeof code !== 'string') {
    res.redirect(`${base}/?oauth=error&reason=exchange_failed`)
    return
  }
  // One use: the nonce cookie goes whatever happens next.
  const cookieNonce = req.cookies?.[STATE_COOKIE]
  res.clearCookie(STATE_COOKIE, stateCookieOpts(req, false))
  if (!verifyState(typeof state === 'string' ? state : undefined)) {
    res.redirect(`${base}/?oauth=error&reason=state_expired`)
    return
  }
  if (!sameNonce(cookieNonce, stateNonce(state as string))) {
    res.redirect(`${base}/?oauth=error&reason=state_mismatch`)
    return
  }

  try {
    const profile = await exchangeCodeForProfile(code, redirectUri(req))
    if (!profile.emailVerified) {
      res.redirect(`${base}/?oauth=error&reason=email_unverified`)
      return
    }
    const user = resolveUser(profile)
    const session = createSession(user.id)
    res.cookie('closet-auth', session.token, cookieOpts(req))
    // The session rides the httpOnly cookie alone — the token is never placed
    // in the URL fragment (it leaked into browser history / shared links).
    res.redirect(`${base}/?oauth=success`)
  } catch (err) {
    if (err instanceof SignupsClosedError) {
      res.redirect(`${base}/?oauth=error&reason=signups_closed`)
      return
    }
    console.error('[google-oauth] callback failed:', err)
    res.redirect(`${base}/?oauth=error`)
  }
}
