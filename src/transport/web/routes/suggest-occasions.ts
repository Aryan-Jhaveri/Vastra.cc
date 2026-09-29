import { Router } from 'express'
import { z } from 'zod'
import { listFacetUsage } from '../../../tools/tags.js'
import { getSetting, setSetting } from '../../../db/queries.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'
import { OCCASIONS } from '../../../types/index.js'

export const PRESETS: string[] = [...OCCASIONS]

const suggestLimiter = perUserRateLimit(60_000, 10)
const MAX_DERIVED = 8

const router = Router()

router.use(suggestLimiter)

router.get('/', async (req, res) => {
  const userId = req.userId!

  const hiddenRaw = getSetting('hiddenSuggestOccasions', userId)
  const hidden: string[] = (() => {
    try { return JSON.parse(hiddenRaw ?? '[]') } catch { return [] }
  })()

  // Custom occasions the user has created, on items or saved outfits, most
  // used first: the same list as "Your occasions" in the editors (#372), so a
  // new or deleted occasion shows up here too. (#284 used outfits only.)
  const derived = listFacetUsage(userId, 'occasion')
    .map(u => u.value)
    .filter(k => !PRESETS.includes(k) && !hidden.includes(k))
    .slice(0, MAX_DERIVED)

  res.json({ presets: PRESETS, derived, hidden })
})

const HideBody = z.object({ value: z.string().min(1).max(40) })

router.post('/hide', async (req, res) => {
  const parsed = HideBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const userId = req.userId!
  const { value } = parsed.data
  const normalised = value.toLowerCase().trim()

  const hiddenRaw = getSetting('hiddenSuggestOccasions', userId)
  const hidden: string[] = (() => {
    try { return JSON.parse(hiddenRaw ?? '[]') } catch { return [] }
  })()

  if (!hidden.includes(normalised)) {
    hidden.push(normalised)
    setSetting('hiddenSuggestOccasions', JSON.stringify(hidden), userId)
  }

  res.status(204).send()
})

export default router
