import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../../db/client.js'
import { loginTokens, users } from '../../../db/schema.js'
import {
  createLoginToken,
  getLoginToken,
  getUserByEmail,
  getUserById,
  createUser,
  createSession,
  deleteSession,
  setUserName,
  setUserAcceptedTerms,
} from '../../../db/queries.js'
import { sendSignInLinkEmail, sendWelcomeEmail } from '../email/index.js'
import { validateEmail } from '../../../auth/emailGuard.js'
import { signupsOpen } from '../../../auth/signups.js'
import { hostedHooks } from '../../../hostedHooks.js'
import { requireSession } from '../middleware.js'
import { cookieOpts } from '../cookies.js'

const router = Router()

// Mirrors the perimeter limiter from server.ts (5 req / 15 min per IP).
// Applied only to mutating endpoints — GET /me must remain hot-path friendly.
// `skip` short-circuits under vitest so a single 127.0.0.1 doesn't burn the
// per-IP budget across tests.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test' || process.env.VITEST === 'true',
})

const TOKEN_TTL_MIN = 15

function allowedDomains(): string[] | undefined {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS
  if (!raw) return undefined
  return raw.split(',').map(d => d.trim()).filter(Boolean)
}

function appUrl(): string {
  return process.env.WEB_APP_URL || 'http://localhost:3000'
}

// ─── POST /api/auth/send-link ─────────────────────────────────────────────────
// Idempotent. Always returns { ok: true } to avoid leaking existence.
const sendLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  acceptedTermsAt: z.number().optional(),
})

router.post('/send-link', authLimiter, async (req, res) => {
  const parsed = sendLinkSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Valid email required' })
  }
  const { email, acceptedTermsAt } = parsed.data

  if (!validateEmail(email, allowedDomains())) {
    return res.status(403).json({ error: 'Please use a Gmail, Outlook/Hotmail, Yahoo, iCloud, or AOL email address.' })
  }

  let user = getUserByEmail(email)
  if (!user) {
    // Closed instance: answer exactly like a sent link, so the form can't be
    // used to find out who has an account.
    if (!signupsOpen()) {
      console.log('[send-link] sign-ups are closed; no account created')
      return res.json({ ok: true })
    }
    user = createUser(email, null)
  }

  // Capture ToS consent now — the user has clicked the checkbox even though
  // they haven't completed verification yet. Only set if not already recorded.
  if (acceptedTermsAt && !user.acceptedTermsAt) {
    setUserAcceptedTerms(user.id, acceptedTermsAt)
  }

  const token = createLoginToken(email)
  const link = `${appUrl()}/auth/verify?token=${encodeURIComponent(token.token)}`

  // Dev/staging convenience: Resend won't send without a key, so the operator
  // can't test the flow end-to-end. Print the link to stdout so it's copyable.
  // Never logged in production (presence of RESEND_API_KEY is the gate).
  if (!process.env.RESEND_API_KEY) {
    console.log(`[send-link] (dev — no RESEND_API_KEY) ${email} → ${link}`)
  } else {
    sendSignInLinkEmail(email, link, TOKEN_TTL_MIN).catch(err => {
      console.warn(`[send-link] failed to send to ${email}:`, (err as Error).message)
    })
  }

  res.json({ ok: true })
})

// ─── GET /api/auth/verify-preview ─────────────────────────────────────────────
// Scanner-safe: pure lookup, never marks usedAt. Idempotent.
router.get('/verify-preview', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : null
  if (!token) {
    return res.status(400).json({ valid: false, expired: false })
  }

  const row = getLoginToken(token)
  if (!row) {
    return res.json({ valid: false, expired: false })
  }

  const now = Date.now()
  const expired = now > row.expiresAt
  const used = row.usedAt !== null
  res.json({
    valid: !expired && !used,
    expired,
    email: row.email,
  })
})

// ─── POST /api/auth/verify-confirm ────────────────────────────────────────────
// One-time consume. Atomic: mark used → set emailVerifiedAt (if first) → create
// session. Side-effects (welcome email + OpenRouter key + ToS backfill) fire
// after the transaction so DB writes can't be re-entered.
// The session is delivered exclusively via the httpOnly cookie — the response
// body never contains the token, and `remember` picks the cookie lifetime
// (persistent 6h vs session-scoped) instead of client-side storage (#295).
router.post('/verify-confirm', authLimiter, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : null
  const remember = req.body?.remember !== false
  if (!token) {
    return res.status(400).json({ error: 'Token required' })
  }

  type ConfirmOk = { ok: true; userId: string; firstVerify: boolean }
  type ConfirmErr = { ok: false; status: number; error: string }

  let outcome: ConfirmOk | ConfirmErr
  try {
    outcome = db.transaction((tx): ConfirmOk | ConfirmErr => {
      const row = tx.select().from(loginTokens).where(eq(loginTokens.token, token)).get()
      if (!row) return { ok: false, status: 400, error: 'Invalid or unknown token' }
      const now = Date.now()
      if (now > row.expiresAt) return { ok: false, status: 400, error: 'Link expired' }
      if (row.usedAt !== null) return { ok: false, status: 400, error: 'Link already used' }

      const user = tx.select().from(users).where(eq(users.email, row.email)).get()
      if (!user) return { ok: false, status: 400, error: 'User not found' }

      tx.update(loginTokens).set({ usedAt: now }).where(eq(loginTokens.token, token)).run()

      const firstVerify = user.emailVerifiedAt === null
      if (firstVerify) {
        tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id)).run()
      }

      return { ok: true, userId: user.id, firstVerify }
    })
  } catch (err) {
    console.error('[verify-confirm] transaction failed:', err)
    return res.status(500).json({ error: 'Could not complete sign-in' })
  }

  if (!outcome.ok) {
    return res.status(outcome.status).json({ error: outcome.error })
  }

  const session = createSession(outcome.userId)
  const user = getUserById(outcome.userId)!

  if (outcome.firstVerify) {
    sendWelcomeEmail(user.email, user.name ?? undefined).catch(err => {
      console.warn(`[verify-confirm] welcome email failed for ${user.email}:`, (err as Error).message)
    })
    // Hosted: mints the user's per-user OpenRouter key. Self-host: nothing.
    hostedHooks().onUserVerified(user.id)
  }

  res.cookie('closet-auth', session.token, cookieOpts(req, remember))
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } })
})

// ─── POST /api/auth/signout (alias: /logout for the existing Settings caller) ─
function handleSignout(req: import('express').Request, res: import('express').Response): void {
  const token = req.cookies?.['closet-auth']
    ?? (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null)
  if (token) deleteSession(token)
  res.clearCookie('closet-auth', cookieOpts(req))
  res.json({ ok: true })
}
router.post('/signout', handleSignout)
router.post('/logout', handleSignout)

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireSession, (req, res) => {
  const user = getUserById(req.userId!)
  // 'self' is the legacy admin identity (fallback bearer or an admin mapped onto it).
  const isAdmin = req.userId === 'self' || !!user?.isAdmin
  res.json({ userId: req.userId, email: user?.email ?? null, name: user?.name ?? null, isAdmin })
})

// ─── PATCH /api/auth/me ───────────────────────────────────────────────────────
const patchMeSchema = z.object({
  name: z.string().trim().min(1).max(128),
})

router.patch('/me', requireSession, (req, res) => {
  const parsed = patchMeSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid name' })
  }
  const { name } = parsed.data
  setUserName(req.userId!, name)
  const user = getUserById(req.userId!)
  res.json({ userId: req.userId!, email: user?.email ?? null, name })
})

export default router
