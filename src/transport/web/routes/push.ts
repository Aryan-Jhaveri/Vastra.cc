import { Router } from 'express'
import webpush from 'web-push'
import { z } from 'zod'
import { upsertPushSubscription, deletePushSubscription } from '../../../jobs/pushStore.js'
import { sendToUserSubs } from '../../../jobs/pushNotify.js'
import { isAllowedPushEndpoint } from '../../../jobs/pushEndpoint.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'

const router = Router()

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? 'mailto:admin@closet.app'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

// GET /api/push/vapid-public-key
router.get('/vapid-public-key', (_req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' })
  res.json({ key: VAPID_PUBLIC_KEY })
})

const SubscribeSchema = z.object({
  endpoint: z.string().refine(isAllowedPushEndpoint, 'Not a browser push service endpoint'),
  keys: z.object({ auth: z.string().min(1).max(256), p256dh: z.string().min(1).max(256) }),
})

const testLimiter = perUserRateLimit(60_000, 3)

// POST /api/push/subscribe
router.post('/subscribe', (req, res) => {
  const userId = req.userId!
  const body = SubscribeSchema.safeParse(req.body)
  if (!body.success) return res.status(400).json({ error: body.error.flatten() })
  const sub = upsertPushSubscription(body.data.endpoint, body.data.keys, userId)
  res.status(201).json({ id: sub.id })
})

// POST /api/push/unsubscribe
router.post('/unsubscribe', (req, res) => {
  const userId = req.userId!
  const { endpoint } = req.body as { endpoint?: string }
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' })
  deletePushSubscription(endpoint, userId)
  res.status(204).send()
})

// POST /api/push/test — send a fixed payload to the current user's devices so
// they can verify push delivery end-to-end from Settings.
router.post('/test', testLimiter, async (req, res) => {
  const userId = req.userId!
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(503).json({ sent: 0, error: 'Push not configured' })
  }
  try {
    const { sent } = await sendToUserSubs(userId, {
      title: 'Vastra.io',
      body: 'Push notifications are working ✓',
      url: '/home#reminders',
    })
    res.json({ sent })
  } catch (err) {
    console.error('[push] test failed:', (err as Error).message)
    res.status(500).json({ sent: 0, error: 'Push test failed' })
  }
})

export default router

// Helper used by scheduler to fan-out notifications
export { webpush, VAPID_PUBLIC_KEY }
