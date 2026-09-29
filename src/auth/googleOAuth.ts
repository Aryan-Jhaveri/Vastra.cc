import { OAuth2Client } from 'google-auth-library'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Google OAuth (Authorization Code flow). Credential-gated like Stripe: the
 * "Continue with Google" button only appears when these env vars are present.
 *
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 *   GOOGLE_OAUTH_REDIRECT_URI  (optional override; otherwise derived per-request)
 */

export interface GoogleProfile {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
}

const SCOPES = ['openid', 'email', 'profile']
const STATE_MAX_AGE_MS = 10 * 60 * 1000

export function isGoogleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET)
}

function clientFor(redirectUri: string): OAuth2Client {
  return new OAuth2Client({
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri,
  })
}

/** Build the Google consent-screen URL the browser is redirected to.
 *
 * access_type: 'online' requests no refresh token. Fine for sign-in only.
 * If the roadmap adds Calendar/Drive integration as the user, revisit this —
 * you'll need access_type: 'offline' + prompt: 'consent' to get refresh tokens. */
export function buildAuthUrl(redirectUri: string, state: string): string {
  return clientFor(redirectUri).generateAuthUrl({
    access_type: 'online',
    scope: SCOPES,
    state,
    prompt: 'select_account',
  })
}

/** Exchange the authorization code for a verified Google profile. */
export async function exchangeCodeForProfile(code: string, redirectUri: string): Promise<GoogleProfile> {
  const client = clientFor(redirectUri)
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new Error('Google did not return an id_token')

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email) throw new Error('Google profile missing sub/email')

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    name: payload.name ?? null,
  }
}

// ─── Stateless CSRF state ───────────────────────────────────────────────────
// We sign the state with HMAC instead of storing a nonce in a cookie. This
// avoids the dev cross-origin cookie problem (Vite :5173 ↔ Express :3000): the
// callback is a top-level navigation from Google with no Origin and a different
// host, so a cookie set at /start would not be sent back. A signed, short-lived
// token is self-contained and verifiable on the callback regardless of host.

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!secret) throw new Error('OAUTH_STATE_SECRET (or GOOGLE_OAUTH_CLIENT_SECRET) is required for state signing')
  return secret
}

export function createState(): string {
  const payload = Buffer.from(
    JSON.stringify({ n: randomBytes(12).toString('hex'), t: Date.now() }),
  ).toString('base64url')
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/**
 * The random nonce inside a state token. /start also sets it as a cookie and
 * the callback requires both to match, so a state + code minted in someone
 * else's browser can't sign this browser in (login CSRF, OSS audit 2026-09-28).
 */
export function stateNonce(state: string | undefined): string | null {
  if (!state || !state.includes('.')) return null
  try {
    const { n } = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString()) as { n?: unknown }
    return typeof n === 'string' && n.length > 0 ? n : null
  } catch {
    return null
  }
}

export function verifyState(state: string | undefined, maxAgeMs: number = STATE_MAX_AGE_MS): boolean {
  if (!state || !state.includes('.')) return false
  const [payload, sig] = state.split('.')
  const expected = createHmac('sha256', stateSecret()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try {
    const { t } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { t: number }
    return typeof t === 'number' && Date.now() - t < maxAgeMs
  } catch {
    return false
  }
}
