import { Router } from 'express'
import { imageUpload, uploadRateLimit } from '../upload.js'
import { createOutfit, listOutfits, deleteOutfit, markOutfitWorn, updateOutfit, getOutfitWithItems, OutfitItemOwnershipError } from '../../../tools/outfits.js'
import { CreateOutfitInputSchema, UpdateOutfitInputSchema } from '../../../types/index.js'
import { listItems } from '../../../tools/items.js'
import { saveImageFromBase64, deleteImage } from '../../../storage/images.js'
import { updateOutfit as dbUpdateOutfit, getOutfit as dbGetOutfit } from '../../../db/queries.js'
import { embedOutfitCoverOnSave, embedOutfitCentroidOnSave, deleteEmbeddingsForOutfit } from '../../../ai/embedImage.js'
import { embedOutfitTextOnSave, deleteTextEmbeddingsForOutfit, textOutfitSourceBlob } from '../../../ai/embed.js'
import { runEmbeddingInstrumented } from '../../../ai/instrumented.js'

const router = Router()
const upload = imageUpload()

const isProd = process.env.NODE_ENV === 'production'
const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

// GET /api/outfits?hydrate=true
router.get('/', async (req, res) => {
  try {
    const userId = req.userId!
    const { occasion, season, hydrate } = req.query as Record<string, string>
    const outfitList = await listOutfits({
      occasion: occasion || undefined,
      season: season || undefined,
    }, userId)

    if (hydrate === 'true') {
      const allItems = await listItems({}, userId)
      const itemMap = new Map(allItems.map(i => [i.id, i]))
      const hydrated = outfitList.map(o => {
        const ids: string[] = JSON.parse(o.itemIds)
        return { ...o, items: ids.map(id => itemMap.get(id)).filter(Boolean) }
      })
      return res.json(hydrated)
    }

    res.json(outfitList)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/outfits/:id — one outfit with its items (Ask tab "View", #339).
// Another user's id is a plain 404.
router.get('/:id', async (req, res) => {
  try {
    const outfit = await getOutfitWithItems(req.params.id, req.userId!)
    if (!outfit) return res.status(404).json({ error: 'Not found' })
    res.json(outfit)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/outfits
router.post('/', async (req, res) => {
  try {
    const userId = req.userId!
    const parsed = CreateOutfitInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }
    const outfit = await createOutfit(parsed.data, userId)
    res.status(201).json(outfit)

    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'multimodalembedding@001', fn: () => embedOutfitCentroidOnSave(outfit, userId) })
    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'gemini-embedding-001', fn: () => embedOutfitTextOnSave(outfit), tokensIn: Math.ceil(textOutfitSourceBlob(outfit).length / 4) })
  } catch (err) {
    if (err instanceof OutfitItemOwnershipError) return res.status(400).json({ error: err.message })
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/outfits/:id
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const parsed = UpdateOutfitInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }
    const outfit = await updateOutfit(req.params.id, parsed.data, userId)
    res.json(outfit)

    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'multimodalembedding@001', fn: () => embedOutfitCentroidOnSave(outfit, userId) })
    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'gemini-embedding-001', fn: () => embedOutfitTextOnSave(outfit), tokensIn: Math.ceil(textOutfitSourceBlob(outfit).length / 4) })
  } catch (err) {
    if (err instanceof OutfitItemOwnershipError) return res.status(400).json({ error: err.message })
    const msg = String(err)
    if (msg.includes('not found')) return res.status(404).json({ error: 'Outfit not found' })
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/outfits/:id/cover — upload cover photo
router.post('/:id/cover', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const outfitId = String(req.params.id)
    const base64 = req.file.buffer.toString('base64')
    const coverImageUri = await saveImageFromBase64(base64, 'outfits', userId)
    const outfit = dbUpdateOutfit(outfitId, userId, { coverImageUri })
    if (!outfit) return res.status(404).json({ error: 'Outfit not found' })
    res.json(outfit)

    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'multimodalembedding@001', fn: () => embedOutfitCoverOnSave(outfit, userId) })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/outfits/:id/cover — remove cover photo
router.delete('/:id/cover', async (req, res) => {
  try {
    const userId = req.userId!
    const current = dbGetOutfit(req.params.id, userId)
    if (!current) return res.status(404).json({ error: 'Outfit not found' })
    // Null the column first: a cover whose file is already gone (or whose URI
    // no longer resolves inside this user's tree) must still be removable —
    // a failed unlink used to 500 here and strand the stale reference (#297).
    const outfit = dbUpdateOutfit(req.params.id, userId, { coverImageUri: null })
    if (!outfit) return res.status(404).json({ error: 'Outfit not found' })
    if (current.coverImageUri) {
      // Best-effort cleanup. resolveImagePath confines unlinks to
      // users/<userId>/ and refuses anything else — a missing file or a
      // refused path must not fail the removal or touch another tenant.
      await deleteImage(current.coverImageUri, userId).catch(() => {})
    }
    res.json(outfit)

    runEmbeddingInstrumented({ userId, task: 'embed_outfit', model: 'multimodalembedding@001', fn: () => embedOutfitCoverOnSave(outfit, userId) })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/outfits/:id
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    await deleteOutfit(req.params.id, userId)
    deleteEmbeddingsForOutfit(req.params.id, userId).catch(() => {})
    deleteTextEmbeddingsForOutfit(req.params.id, userId).catch(() => {})
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/outfits/:id/worn
router.post('/:id/worn', async (req, res) => {
  try {
    const userId = req.userId!
    const outfit = await markOutfitWorn(req.params.id, userId)
    res.json(outfit)
  } catch (err) {
    if (err instanceof OutfitItemOwnershipError) return res.status(400).json({ error: err.message })
    const msg = String(err)
    if (msg.includes('not found')) return res.status(404).json({ error: 'Outfit not found' })
    res.status(500).json({ error: errMsg(err) })
  }
})

export default router
