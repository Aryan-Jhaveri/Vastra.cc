import { Router } from 'express'
import { hostedHooks } from '../../../hostedHooks.js'
import { deleteUserAccount, setUserAcceptedTerms } from '../../../db/queries.js'
import { deleteUserImageDirectory } from '../../../storage/images.js'
import { cookieOpts } from '../cookies.js'

const router = Router()

// POST /api/account/accept-terms — record one-time ToS/Privacy acceptance.
// Used by the billing flow when a pre-launch user (backfilled) or an account
// that signed up before consent existed wants to top up.
router.post('/accept-terms', (req, res) => {
  const ts = Date.now()
  setUserAcceptedTerms(req.userId!, ts)
  res.json({ acceptedTermsAt: ts })
})

// DELETE /api/account — self-serve account deletion.
//
// Fail-closed ordering: revoke the user's OpenRouter key FIRST. If that throws
// we return 500 and delete NOTHING, so the user keeps a consistent account and
// can retry. Only on a clean revoke do we drop DB rows + the on-disk image dir.
router.delete('/', async (req, res) => {
  const userId = req.userId!
  // An admin mapped onto the legacy shared 'self' closet would otherwise wipe
  // that shared closet, not their own account (OSS audit 2026-09-28).
  if (req.authUserId && req.authUserId !== userId) {
    return res.status(409).json({ error: 'shared_closet', detail: 'This admin account acts as the shared closet. Delete it with admin.mjs delete-user instead.' })
  }

  try {
    await hostedHooks().beforeAccountDelete(userId)
  } catch (err) {
    return res.status(500).json({ error: 'openrouter_revoke_failed', detail: (err as Error).message })
  }

  try {
    deleteUserAccount(userId)
    await deleteUserImageDirectory(userId)
  } catch (err) {
    return res.status(500).json({ error: 'deletion_failed', detail: (err as Error).message })
  }

  res.clearCookie('closet-auth', cookieOpts(req))
  res.json({ ok: true })
})

export default router
