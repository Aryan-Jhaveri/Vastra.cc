import { Router } from 'express'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { db } from '../../../db/client.js'
import { analyticsEvents } from '../../../db/schema.js'
import rateLimit from 'express-rate-limit'

const AnalyticsEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  eventType: z.string().min(1).max(128),
  route: z.string().max(256).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  pwaMode: z.coerce.number().int().min(0).max(1).optional().default(0),
  durationMs: z.number().int().positive().optional(),
  createdAt: z.number().int().positive(),
})

const BatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(50),
})

const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
})

const router = Router()

router.post('/', analyticsLimiter, (req, res) => {
  const parsed = BatchSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  const now = Date.now()
  const rows = parsed.data.events.map(e => ({
    id: e.id,
    userId: (req as any).userId ?? null,
    sessionId: e.sessionId,
    eventType: e.eventType,
    route: e.route ?? null,
    properties: JSON.stringify(e.properties ?? {}),
    pwaMode: e.pwaMode,
    durationMs: e.durationMs ?? null,
    createdAt: Math.min(e.createdAt, now),
  }))

  try {
    db.insert(analyticsEvents).values(rows).run()
  } catch (err) {
    console.error('[analytics] failed to insert events:', (err as Error).message)
    return res.status(500).json({ error: 'Failed to store events' })
  }

  res.status(204).end()
})

export default router
