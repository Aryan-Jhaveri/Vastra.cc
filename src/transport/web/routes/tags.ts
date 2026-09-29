import { Router } from 'express'
import { z } from 'zod'
import { deleteFacetEverywhere, listFacetUsage } from '../../../tools/tags.js'

// #372 — /api/tags: the user's created tags and occasions, and deleting one
// from everything that uses it. Mounted behind requireSession + CSRF.

const router = Router()

const Kind = z.enum(['tag', 'occasion'])
const DeleteBody = z.object({ kind: Kind, values: z.array(z.string().trim().min(1).max(50)).min(1).max(50) })

// GET /api/tags?kind=tag|occasion → { values: [{ value, items, outfits, collections }] }
router.get('/', (req, res) => {
  const kind = Kind.safeParse(req.query.kind ?? 'tag')
  if (!kind.success) { res.status(400).json({ error: 'kind must be tag or occasion' }); return }
  res.json({ values: listFacetUsage(req.userId!, kind.data) })
})

// POST /api/tags/delete { kind, values } → { items, outfits, collections } changed
router.post('/delete', (req, res) => {
  const body = DeleteBody.safeParse(req.body)
  if (!body.success) { res.status(400).json({ error: 'Invalid body' }); return }
  res.json(deleteFacetEverywhere(req.userId!, body.data.kind, body.data.values))
})

export default router
