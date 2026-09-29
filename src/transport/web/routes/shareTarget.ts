import { Router } from 'express'
import { imageUpload } from '../upload.js'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { nanoid } from 'nanoid'
import { saveImageFromBase64 } from '../../../storage/images.js'
import { createShareInboxPayload } from '../../../tools/share.js'

const router = Router()
const upload = imageUpload()

// Anonymous shares are short-lived: the user must log in (or sign up) and claim
// the row, which extends the expiry. Authed inbox rows live longer so a leisurely
// user isn't cut off mid-flow, but still expire so a dismissed chooser doesn't
// leave a permanent orphan — the cleanup cron purges both cohorts on expiry.
const ANON_TTL_MS = 15 * 60 * 1000
const AUTHED_INBOX_TTL_MS = 24 * 60 * 60 * 1000

// This route is reachable anonymously and every accepted request runs sharp and
// writes to disk, so it is throttled before multer buffers the upload. Anonymous
// callers share a per-IP bucket; signed-in callers get their own per-user bucket
// so a shared NAT doesn't lock out real users.
const shareTargetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (req) => (req.userId ? 60 : 10),
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many shares, try again later' },
})

// POST /share-target — OS share-sheet target (W3C Web Share Target, server-handled).
// Mounted OUTSIDE /api with attachSession (non-rejecting), so anonymous shares
// flow through to the login+claim path instead of 401ing.
router.post('/', shareTargetLimiter, (req, res) => {
  upload.single('image')(req, res, async (err: unknown) => {
    if (err) {
      // multer rejects (e.g. file too large) land here.
      return res.status(400).json({ error: 'Upload failed' })
    }

    try {
      const file = req.file
      // Phase 1 only handles image shares. Text/URL-only shares (no file) → 400.
      if (!file || !file.mimetype?.startsWith('image/')) {
        return res.status(400).json({ error: 'An image file is required' })
      }

      const authedUserId = req.userId
      const isAnon = !authedUserId
      const userId = authedUserId ?? '__anon__'
      const claimToken = isAnon ? nanoid(24) : null
      const expiresAt = Date.now() + (isAnon ? ANON_TTL_MS : AUTHED_INBOX_TTL_MS)

      const imageUri = await saveImageFromBase64(file.buffer.toString('base64'), 'share-inbox', userId)
      const payload = createShareInboxPayload({
        userId,
        imageUri,
        expiresAt,
        claimToken,
        intendedAction: null,
      })

      // W3C share-target spec: respond with a 303 redirect to a GET page.
      if (isAnon) {
        const next = `/?share=${payload.id}&kind=inbox&claim=${claimToken}`
        return res.redirect(303, `/login?next=${encodeURIComponent(next)}`)
      }
      return res.redirect(303, `/?share=${payload.id}&kind=inbox`)
    } catch (e) {
      console.error('[share-target]', e)
      return res.status(500).json({ error: 'Could not process shared image' })
    }
  })
})

export default router
