import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual, createHmac } from 'crypto'
import { getSystemSetting, getSessionByToken, getUserById } from '../../db/queries.js'
import { isUserAdmin, getApiTokenByPlaintext, touchApiToken, type ApiTokenScope } from '../../db/queries.js'
import { isShopEnabled } from '../../commerce/shopify/enabled.js'
import { isChatEnabled } from '../../agent/chatEnabled.js'

declare global {
  namespace Express {
    interface Request {
      userId?: string
      /** The signed-in account itself. Differs from userId only for an admin
       *  mapped onto the legacy shared 'self' closet (OSS audit 2026-09-28). */
      authUserId?: string
      // How requireSession authenticated this request. The CSRF middleware
      // only trusts a bearer-authenticated client to skip the cookie-proof
      // check — a mere Authorization header (e.g. browser-cached Basic creds)
      // must NOT bypass CSRF when the request actually authenticated by
      // cookie (#295 review item 2).
      authVia?: 'bearer' | 'cookie'
      // Scoped API token identity (#321). Set only by requireApiToken on the
      // /mcp + /api/ha/* mounts. Downstream rate limiters read scopes for the
      // stricter `ai` budget.
      tokenScopes?: ApiTokenScope[]
      tokenId?: string
    }
  }
}

// #321 — HOSTED_MODE gates the personal-API-token surface. A remote MCP
// endpoint on the public SaaS is a bigger attack surface and stays hidden
// until #248 (Helmet CSP, bearer-only mutations, rate limits) lands. Self-host
// (env unset / not 'true') has tokens on by default.
//
// The definition lives in src/hostedMode.ts so core layers (billing, ai, jobs)
// can read it without a dependency up into the transport layer. Imported
// locally (so in-file callers have a binding) and re-exported to keep this
// module's existing callers (server.ts) unchanged.
import { isHostedMode } from '../../hostedMode.js'
export { isHostedMode }

// Checked per request (not at mount time) so the gate is testable and a
// future mount can't forget it: in HOSTED_MODE the token surface 404s.
export function requireTokensEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (isHostedMode()) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  next()
}

export function sessionToken(password: string): string {
  return createHmac('sha256', 'closet-session-v1').update(password).digest('hex')
}

// Legacy admin-fallback tokens are HMAC(fixed key, WEB_AUTH_PASSWORD): guessing
// one is guessing the password. Only the password form had a rate limit, so a
// bearer header allowed unlimited online guesses (OSS audit 2026-09-28). After
// FALLBACK_MAX_FAILURES wrong tokens from one IP in the window, fallback tokens
// from that IP aren't compared at all. Real sessions are checked first and are
// unaffected.
const FALLBACK_WINDOW_MS = 15 * 60_000
const FALLBACK_MAX_FAILURES = 20
const FALLBACK_MAX_TRACKED = 10_000
const fallbackFailures = new Map<string, { count: number; resetAt: number }>()

export function matchesAdminFallback(token: string, ip: string | undefined, now = Date.now()): boolean {
  if (!ADMIN_FALLBACK) return false
  const pw = process.env.WEB_AUTH_PASSWORD
  if (!pw) return false
  const key = ip ?? 'unknown'
  const entry = fallbackFailures.get(key)
  if (entry && entry.resetAt <= now) fallbackFailures.delete(key)
  const live = fallbackFailures.get(key)
  if (live && live.count >= FALLBACK_MAX_FAILURES) return false
  if (safeEqual(token, sessionToken(pw))) return true
  if (fallbackFailures.size >= FALLBACK_MAX_TRACKED) {
    for (const [k, v] of fallbackFailures) if (v.resetAt <= now) fallbackFailures.delete(k)
  }
  if (live) live.count++
  else if (fallbackFailures.size < FALLBACK_MAX_TRACKED) fallbackFailures.set(key, { count: 1, resetAt: now + FALLBACK_WINDOW_MS })
  return false
}

/** Test helper. */
export function resetAdminFallbackFailures(): void {
  fallbackFailures.clear()
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function getPassword(): string | null {
  return getSystemSetting('password') ?? process.env.WEB_AUTH_PASSWORD ?? null
}

function extractBearer(req: Request): string | null {
  const authHeader = req.headers['authorization']
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  return null
}

const ADMIN_FALLBACK = process.env.ADMIN_BEARER_FALLBACK === 'true'

// Admins act as the canonical 'self' user — their requests are rewritten so
// they see/edit the shared closet rather than their own (empty) namespace.
// Per-user analytics/billing for admins is intentionally attributed to 'self'.
//
// Only while that legacy 'self' row exists (vastra.cc, or an install that ran
// with ADMIN_BEARER_FALLBACK). A fresh self-hosted instance has none: its
// admin (from create-admin) is simply their own user, or every write would
// hit a missing 'self' row (#315).
let selfUserSeen = false
function legacySelfUserExists(): boolean {
  if (!selfUserSeen) selfUserSeen = !!getUserById('self')
  return selfUserSeen
}

function resolveEffectiveUserId(rawUserId: string): string {
  if (rawUserId === 'self') return 'self'
  return isUserAdmin(rawUserId) && legacySelfUserExists() ? 'self' : rawUserId
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const bearer = extractBearer(req)
  const token = bearer ?? req.cookies?.['closet-auth']

  if (token) {
    // Try session-based auth first
    const session = getSessionByToken(token)
    if (session && session.expiresAt > Date.now()) {
      req.userId = resolveEffectiveUserId(session.userId)
      req.authUserId = session.userId
      req.authVia = bearer ? 'bearer' : 'cookie'
      next()
      return
    }

    // If ADMIN_BEARER_FALLBACK is enabled, try the old password-based auth
    // Use WEB_AUTH_PASSWORD directly (not getPassword) so fallback always
    // matches the /api/auth endpoint, regardless of DB-stored passwords.
    // The fallback token is password-derived, but CSRF applicability follows
    // the TRANSPORT: via Authorization header it's a non-browser bearer
    // (admin.mjs); via cookie (the admin browser form on POST /api/auth) it
    // is a cookie session and still needs the CSRF proof (#295 review).
    if (matchesAdminFallback(token, req.ip)) {
      req.userId = 'self'
      req.authVia = bearer ? 'bearer' : 'cookie'
      next()
      return
    }
  }

  res.status(401).json({ error: 'Unauthorized' })
}

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearer(req)

  if (token) {
    const session = getSessionByToken(token)
    if (session && session.expiresAt > Date.now()) {
      req.userId = resolveEffectiveUserId(session.userId)
      req.authUserId = session.userId
      req.authVia = 'bearer'
      next()
      return
    }

    if (matchesAdminFallback(token, req.ip)) {
      req.userId = 'self'
      req.authVia = 'bearer'
      next()
      return
    }
  }

  res.status(401).json({ error: 'Unauthorized' })
}

// Non-rejecting session resolver (#165). Populates req.userId when a valid
// session cookie/bearer (or the admin fallback) is present, but NEVER rejects —
// so it can run globally ahead of the request logger to give every line a
// userId, while unauthenticated/public routes still pass through to their own
// handlers. Mirrors requireSession's resolution without the 401.
export function attachSession(req: Request, _res: Response, next: NextFunction): void {
  const bearer = extractBearer(req)
  const token = bearer ?? req.cookies?.['closet-auth']

  if (token) {
    const session = getSessionByToken(token)
    if (session && session.expiresAt > Date.now()) {
      req.userId = resolveEffectiveUserId(session.userId)
      req.authUserId = session.userId
      req.authVia = bearer ? 'bearer' : 'cookie'
    } else if (matchesAdminFallback(token, req.ip)) {
      req.userId = 'self'
      req.authVia = bearer ? 'bearer' : 'cookie'
    }
  }

  next()
}

// Admin gate. Must run AFTER requireSession (which populates req.userId).
// Accepts either the legacy 'self' identity (break-glass via ADMIN_BEARER_FALLBACK)
// or a normal session whose user row has is_admin=1.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.userId === 'self') { next(); return }
  if (req.userId && isUserAdmin(req.userId)) { next(); return }
  res.status(403).json({ error: 'Admin required' })
}

// Old password-based auth — kept for backward compat; gated behind env var
export function authGuard(req: Request, res: Response, next: NextFunction): void {
  const password = getPassword()
  if (!password) {
    next()
    return
  }

  const expected = sessionToken(password)

  const token = extractBearer(req) ?? req.cookies?.['closet-auth']

  if (token && safeEqual(token, expected)) {
    next()
    return
  }

  res.status(401).json({ error: 'Unauthorized' })
}

// #324 — 404 the shop surface (/api/shop, /.well-known/ucp) per request unless
// SHOP_ROW_ENABLED=true, so self-host is off by default.
export function requireShopEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isShopEnabled()) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  next()
}

// #328 — 404 the chat surface (/api/chat/*) per request unless chat is on:
// self-host with a usable text model, or hosted with CHAT_ENABLED=true.
export function requireChatEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isChatEnabled()) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  next()
}

// #321 — Personal API token auth. Mounted ONLY on /mcp and /api/ha/*; the
// rest of /api/* stays cookie + CSRF. A token authenticates a non-browser
// client (Claude Desktop, Home Assistant, scripts) as a user with scopes.
//
// Security contract:
// - The plaintext is never logged. It is hashed (SHA-256) and looked up by the
//   unique index on token_hash; getApiTokenByPlaintext additionally asserts a
//   constant-time compare as a guard.
// - Revoked, expired and unknown tokens all return the SAME 401 so a probe
//   can't distinguish "no such token" from "revoked" / "expired".
// - A cookie is NOT accepted here (cookies don't work on /mcp). Only a Bearer
//   token in the Authorization header authenticates.
// - Scope enforcement: every scope in `requiredScopes` must be present on the
//   token, else 403. `read` is always granted (it's the default at creation).
// - On success, req.userId / req.authVia='bearer' / req.tokenScopes /
//   req.tokenId are set, and lastUsedAt is bumped (best-effort).
export function requireApiToken(requiredScopes: ApiTokenScope[]) {
  return function requireApiTokenImpl(req: Request, res: Response, next: NextFunction): void {
    // HOSTED_MODE: tokens minted before the flag flipped must stop working too.
    if (isHostedMode()) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const plaintext = extractBearer(req)
    if (!plaintext) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const row = getApiTokenByPlaintext(plaintext)
    if (!row) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // Revoked or expired → indistinguishable 401.
    if (row.revokedAt !== null) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // Scope enforcement.
    for (const need of requiredScopes) {
      if (!row.scopesArr.includes(need)) {
        res.status(403).json({ error: 'Insufficient scope' })
        return
      }
    }

    req.userId = row.userId
    req.authVia = 'bearer'
    req.tokenScopes = row.scopesArr
    req.tokenId = row.id

    // Best-effort lastUsedAt touch — never block the response on it.
    try { touchApiToken(row.id) } catch { /* ignore */ }

    next()
  }
}
