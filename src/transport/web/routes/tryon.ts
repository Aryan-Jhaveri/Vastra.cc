import { Router } from 'express'
import { imageUpload, uploadRateLimit } from '../upload.js'
import * as queries from '../../../db/queries.js'
import { deleteImage, saveImageFromBase64 } from '../../../storage/images.js'
import { isModelBusy } from '../../../ai/client.js'
import { ImageGenUserBusyError, TooManyReferencesError } from '../../../ai/localImage.js'
import { runTryOn, suggestWearForItems, TryOnNotFoundError } from '../../../tools/tryon.js'
import { respondInsufficientTokens } from '../billingErrors.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'

const router = Router()
const upload = imageUpload()

// Rate-limit only the free + UI-auto-fired /suggestions route. The paid
// surfaces (POST /api/tryon, POST /api/tryon/garments precursor) have economic
// guardrails via the token wallet — no need for app-layer throttles on users
// who are paying per call.
const tryonSuggestionsLimiter = perUserRateLimit(60_000, 6)

const isProd = process.env.NODE_ENV === 'production'
const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

// GET /api/tryon — fetch try-on history
router.get('/', async (req, res) => {
  try {
    const userId = req.userId!
    res.json(queries.getTryonResults(userId))
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/tryon/:id — delete a result
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const results = queries.getTryonResults(userId)
    const result = results.find(r => r.id === req.params.id)
    if (!result) return res.status(404).json({ error: 'Not found' })
    await deleteImage(result.resultImageUri, userId)
    queries.deleteTryonResult(req.params.id, userId)
    res.status(204).end()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/tryon/:id — link a tryon result to an outfit (idempotent)
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const { outfitId } = req.body as { outfitId?: string }
    if (!outfitId) return res.status(400).json({ error: 'outfitId is required' })

    const results = queries.getTryonResults(userId)
    const result = results.find(r => r.id === req.params.id)
    if (!result) return res.status(404).json({ error: 'Tryon result not found' })

    if (result.outfitId) {
      const outfit = queries.getOutfit(result.outfitId, userId)
      return res.status(409).json({ outfitId: result.outfitId, outfit })
    }

    if (!queries.getOutfit(outfitId, userId)) return res.status(404).json({ error: 'Outfit not found' })

    const updated = queries.updateTryonResult(req.params.id, userId, { outfitId })
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/tryon/suggestions — refine chips for a set of closet items (no image gen)
// body: { itemIds: string[], sourceOutfitId?: string }
router.post('/suggestions', tryonSuggestionsLimiter, async (req, res) => {
  try {
    const userId = req.userId!
    const { itemIds, sourceOutfitId } = req.body as { itemIds?: string[]; sourceOutfitId?: string }
    if (!itemIds?.length) return res.status(400).json({ error: 'itemIds required' })

    const items = itemIds.map(id => queries.getItem(id, userId)).filter((i): i is NonNullable<typeof i> => Boolean(i))
    const primaryUris = items.map(item => queries.getItemImages(item.id, userId).find(i => i.isPrimary === 1)?.imageUri ?? item.imageUri)
    const suggestions = await suggestWearForItems({
      userId,
      items,
      primaryUris,
      outfitId: typeof sourceOutfitId === 'string' ? sourceOutfitId : undefined,
    })
    res.json({ suggestions })
  } catch (err) {
    console.error('[tryon] POST /suggestions error:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/tryon/garments — upload an ephemeral garment photo (not saved to closet)
router.post('/garments', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'image file is required' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const base64 = req.file.buffer.toString('base64')
    const imageUri = await saveImageFromBase64(base64, 'garments', userId)
    res.status(201).json({ imageUri })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/tryon
// body: { userPhotoId: string, itemIds: string[], garmentUris?: string[], userInstruction?: string }
router.post('/', async (req, res) => {
  try {
    const userId = req.userId!
    const { userPhotoId, itemIds, garmentUris, userInstruction, sourceOutfitId } = req.body as {
      userPhotoId?: string
      itemIds?: string[]
      garmentUris?: string[]
      userInstruction?: string
      sourceOutfitId?: string
    }

    if (!userPhotoId) return res.status(400).json({ error: 'userPhotoId is required' })
    if (!itemIds?.length && !garmentUris?.length) return res.status(400).json({ error: 'Must provide at least one item or garment upload' })

    const { resultImageUri, tryonId, wearSuggestions, droppedViews } = await runTryOn({
      userId, userPhotoId, itemIds, garmentUris, userInstruction,
      sourceOutfitId: typeof sourceOutfitId === 'string' ? sourceOutfitId : undefined,
    })
    res.status(201).json({ resultImageUri, tryonId, wearSuggestions, ...(droppedViews ? { droppedViews } : {}) })
  } catch (err) {
    if (err instanceof TryOnNotFoundError) return res.status(404).json({ error: err.message })
    if (respondInsufficientTokens(err, res)) return
    if (err instanceof TooManyReferencesError || err instanceof ImageGenUserBusyError) {
      return res.status(err.status).json({ error: err.message })
    }
    if (isModelBusy(err)) {
      console.warn('[tryon] POST /api/tryon: model busy (503), all retries exhausted')
      return res.status(503).json({ error: 'AI model is currently busy — please try again in a few seconds' })
    }
    console.error('[tryon] POST /api/tryon error:', err instanceof Error ? err.message : err)
    res.status(500).json({ error: errMsg(err) })
  }
})

export default router
