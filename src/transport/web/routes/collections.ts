import { Router } from 'express'
import { imageUpload, uploadRateLimit } from '../upload.js'
import {
  createCollection, listCollections, getCollection, updateCollection,
  deleteCollection, addOutfitsToCollection, removeOutfitFromCollection,
  reorderOutfitsInCollection, getCollectionIdsForOutfit,
} from '../../../tools/collections.js'
import { listItems } from '../../../tools/items.js'
import { CreateCollectionInputSchema, UpdateCollectionInputSchema } from '../../../types/index.js'
import {
  getAllOutfits, updateCollection as dbUpdateCollection, getCollection as dbGetCollection,
  getOutfitIdsInCollection as dbGetOutfitIds,
} from '../../../db/queries.js'
import { saveImageSquareCrop, deleteImage } from '../../../storage/images.js'

const router = Router()
const upload = imageUpload()

const isProd = process.env.NODE_ENV === 'production'
const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

// GET /api/collections?hydrate=true
router.get('/', async (req, res) => {
  try {
    const userId = req.userId!
    const { hydrate } = req.query as Record<string, string>
    const cols = await listCollections(userId)

    if (hydrate === 'true') {
      const allOutfits = getAllOutfits(userId)
      const allItems = await listItems({}, userId)
      const itemMap = new Map(allItems.map(i => [i.id, i]))
      const outfitMap = new Map(allOutfits.map(o => [o.id, o]))

      const hydrated = cols.map(col => {
        const outfitIds = dbGetOutfitIds(col.id, userId)
        const hydratedOutfits = outfitIds
          .map((oid: string) => outfitMap.get(oid))
          .filter((o): o is NonNullable<typeof o> => Boolean(o))
          .map(o => {
            const ids: string[] = JSON.parse(o.itemIds)
            return { ...o, items: ids.map(id => itemMap.get(id)).filter(Boolean) }
          })
        return { ...col, outfitCount: hydratedOutfits.length, outfits: hydratedOutfits }
      })
      return res.json(hydrated)
    }

    const withCounts = cols.map(col => ({
      ...col,
      outfitCount: dbGetOutfitIds(col.id, userId).length,
    }))
    res.json(withCounts)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/collections/:id?hydrate=true
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const col = await getCollection(req.params.id, userId)
    if (!col) return res.status(404).json({ error: 'Collection not found' })

    const { hydrate } = req.query as Record<string, string>
    if (hydrate === 'true') {
      const allOutfits = getAllOutfits(userId)
      const allItems = await listItems({}, userId)
      const itemMap = new Map(allItems.map(i => [i.id, i]))
      const outfitMap = new Map(allOutfits.map(o => [o.id, o]))
      const outfitIds = dbGetOutfitIds(col.id, userId)
      const hydratedOutfits = outfitIds
        .map((oid: string) => outfitMap.get(oid))
        .filter((o): o is NonNullable<typeof o> => Boolean(o))
        .map(o => {
          const ids: string[] = JSON.parse(o.itemIds)
          return { ...o, items: ids.map(id => itemMap.get(id)).filter(Boolean) }
        })
      return res.json({ ...col, outfitCount: hydratedOutfits.length, outfits: hydratedOutfits })
    }

    const outfitIds = dbGetOutfitIds(col.id, userId)
    res.json({ ...col, outfitCount: outfitIds.length })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/collections
router.post('/', async (req, res) => {
  try {
    const userId = req.userId!
    const parsed = CreateCollectionInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }
    const col = await createCollection(parsed.data, userId)
    res.status(201).json(col)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/collections/:id
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const parsed = UpdateCollectionInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }
    const col = await updateCollection(req.params.id, parsed.data, userId)
    res.json(col)
  } catch (err) {
    const msg = String(err)
    if (msg.includes('not found')) return res.status(404).json({ error: 'Collection not found' })
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/collections/:id/cover
router.post('/:id/cover', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const base64 = req.file.buffer.toString('base64')
    const coverImageUri = await saveImageSquareCrop(base64, 'collections', userId)
    const col = dbUpdateCollection(String(req.params.id), userId, { coverImageUri })
    if (!col) return res.status(404).json({ error: 'Collection not found' })
    res.json(col)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/collections/:id/cover
router.delete('/:id/cover', async (req, res) => {
  try {
    const userId = req.userId!
    const current = dbGetCollection(req.params.id, userId)
    if (!current) return res.status(404).json({ error: 'Collection not found' })
    if (current.coverImageUri) await deleteImage(current.coverImageUri, userId)
    const col = dbUpdateCollection(req.params.id, userId, { coverImageUri: null })
    res.json(col)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/collections/:id/outfits — bulk add
router.post('/:id/outfits', async (req, res) => {
  try {
    const userId = req.userId!
    const col = await getCollection(req.params.id, userId)
    if (!col) return res.status(404).json({ error: 'Collection not found' })
    const { outfitIds } = req.body as { outfitIds: string[] }
    if (!Array.isArray(outfitIds) || outfitIds.length === 0) {
      return res.status(400).json({ error: 'outfitIds must be a non-empty array' })
    }
    await addOutfitsToCollection(req.params.id, outfitIds, userId)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/collections/:id/outfits/:outfitId
router.delete('/:id/outfits/:outfitId', async (req, res) => {
  try {
    await removeOutfitFromCollection(req.params.id, req.params.outfitId, req.userId!)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/collections/:id/outfits/order
router.patch('/:id/outfits/order', async (req, res) => {
  try {
    const { orderedIds } = req.body as { orderedIds: string[] }
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' })
    await reorderOutfitsInCollection(req.params.id, orderedIds, req.userId!)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/collections/for-outfit/:outfitId
router.get('/for-outfit/:outfitId', async (req, res) => {
  try {
    const collectionIds = await getCollectionIdsForOutfit(req.params.outfitId, req.userId!)
    res.json(collectionIds)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/collections/:id
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const col = await getCollection(req.params.id, userId)
    if (!col) return res.status(404).json({ error: 'Collection not found' })
    if (col.coverImageUri) await deleteImage(col.coverImageUri, userId)
    await deleteCollection(req.params.id, userId)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

export default router
