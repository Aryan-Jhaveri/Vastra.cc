import { Router } from 'express'
import { embeddingStatus, pruneSuperseded, startReembed } from '../../../ai/embedReindex.js'

// #353 — admin view of embedding coverage after a model/dimension switch.
// Mounted behind requireSession + CSRF + requireAdmin. Instance-wide counts
// only; no vectors, text or user ids are returned.
const router = Router()

router.get('/status', (_req, res) => {
  res.json(embeddingStatus())
})

// Start a resumable background re-embed. Progress: poll GET /status.
router.post('/reembed', (_req, res) => {
  const started = startReembed()
  res.status(started ? 202 : 409).json({ started, status: embeddingStatus() })
})

// Delete rows written by a previous model. Refused while a pass runs, or
// before every enabled level is fully covered unless { force: true }.
router.post('/prune', (req, res) => {
  const result = pruneSuperseded({ force: req.body?.force === true })
  if (!result.ok) {
    const error = result.reason === 'running'
      ? 'A re-embed is running; prune when it finishes'
      : 'Not every item/outfit/share has a vector from the current model yet; run a re-embed first, or pass { force: true }'
    res.status(409).json({ ok: false, reason: result.reason, error })
    return
  }
  res.json(result)
})

export default router
