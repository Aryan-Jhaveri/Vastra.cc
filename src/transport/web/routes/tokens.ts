import { Router } from 'express'
import { createApiToken, listApiTokens, revokeApiToken, type ApiTokenScope } from '../../../db/queries.js'

const router = Router()

// #321 — Personal API token management. These routes are browser-managed
// (Settings → Connections): they authenticate with the cookie session and the
// CSRF proof, NOT with an API token. The token itself is only ever used on
// /mcp and /api/ha/* (mounted with requireApiToken).
//
// The plaintext token is returned EXACTLY ONCE on creation; the response
// carries Cache-Control: no-store so it can't be replayed from a shared cache.

// Revoked/expired rows stay in the DB for audit but aren't listed — Settings
// shows only tokens that can still authenticate.
router.get('/', (req, res) => {
  const now = Date.now()
  res.json(listApiTokens(req.userId!).filter(t =>
    t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now)))
})

router.post('/', (req, res) => {
  // A token minted while an admin acts as the shared 'self' closet would be
  // owned by 'self' and outlive the admin's demotion (OSS audit 2026-09-28).
  if (req.authUserId && req.authUserId !== req.userId) {
    return res.status(409).json({ error: 'shared_closet', detail: "Tokens can't be created for the shared closet." })
  }
  const { name, scopes } = req.body as { name?: string; scopes?: unknown }
  try {
    const { plaintext, token } = createApiToken(req.userId!, name ?? '', scopes)
    res.setHeader('Cache-Control', 'no-store')
    res.json({ token, plaintext })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.delete('/:id', (req, res) => {
  const ok = revokeApiToken(req.userId!, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Token not found' })
  res.json({ ok: true })
})

export default router
export type { ApiTokenScope }
