import { Router } from 'express'
import { imageUpload, uploadRateLimit } from '../upload.js'
import { addItem, listItems, getItem, updateItem, deleteItem, markWorn, countItems, listItemCards } from '../../../tools/items.js'
import { AddItemInputSchema, UpdateItemInputSchema } from '../../../types/index.js'
import { categorizeItem } from '../../../ai/categorize.js'
import { scanTag } from '../../../ai/scanTag.js'
import { detectItems } from '../../../ai/detectItems.js'
import { saveImageFromBase64, imageToBase64, compressBuffer, deleteImage, cropSourceBox, UnsupportedImageError } from '../../../storage/images.js'
import {
  updateItem as dbUpdateItem, getUniqueTags, getUniqueSubcategories, getUniqueCategories,
  getItemImages, insertItemImage, deleteItemImage, getItemImage, setItemImagePrimary,
} from '../../../db/queries.js'
import { generateHeroImage } from '../../../ai/heroImage.js'
import { claimItemCreateKey, completeItemCreateKey, releaseItemCreateKey, IDEMPOTENCY_KEY_RE } from '../../../db/itemCreateKeys.js'
import { runInstrumented, runEmbeddingInstrumented, runInstrumentedDetailed, isMockImageGen } from '../../../ai/instrumented.js'
import { updateAiCallLinks } from '../../../ai/aiCalls.js'
import { tokenCost } from '../../../cost/tokenTable.js'
import { respondInsufficientTokens } from '../billingErrors.js'
import { z } from 'zod'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'
import { embedItemOnSave, deleteEmbeddingsForItem } from '../../../ai/embedImage.js'
import { embedItemTextOnSave, deleteTextEmbeddingsForItem, textItemSourceBlob } from '../../../ai/embed.js'
import { VISION_MODEL } from '../../../ai/client.js'
import { detectionModel } from '../../../ai/localModel.js'
import { imageGenMaxRefs, imageGenModel, isLocalImageGen, ImageGenUserBusyError } from '../../../ai/localImage.js'
import { db } from '../../../db/client.js'
import { aiCalls } from '../../../db/schema.js'
import { eq, and, gte } from 'drizzle-orm'
import { startOfNextUtcMonthMs, startOfUtcMonthMs } from '../../../time/utcDay.js'

const MAX_REF_IMAGES = 8
const MAX_REF_BYTES = 10 * 1024 * 1024
const OCR_MONTHLY_LIMIT = 10

const router = Router()
const upload = imageUpload()

// categorize / detect / scan-tag / bulk routes stay rate-limited: they're
// either free or cheap per-call but easy to amplify via bulk inputs.
// make_pretty (POST /:id/thumbnail) is paid per call (16 tokens) — the wallet
// already gates abuse, so no app-layer limit.
//
// Budget: 30/min per user, shared by detect / analyze / tag scan (one limiter
// instance = one bucket). Deliberately NOT raised for bulk Add Item: those
// calls are free to the user and funded from our Gemini quota, and the client
// now paces itself on 429 (Retry-After is sent via standardHeaders).
const categorizeLimiter = perUserRateLimit(60_000, 30)
// Saves (POST /api/items) get their own bucket at the same rate. They run no
// generative call (only the per-item embeddings), and when they shared the AI
// bucket a large batch's background classify pass starved the user's swipes:
// every save 429'd until classification finished.
const saveLimiter = perUserRateLimit(60_000, 30)

const isProd = process.env.NODE_ENV === 'production'
const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

// GET /api/items?category=&page=&limit=
router.get('/', async (req, res) => {
  try {
    const userId = req.userId!
    const { color, season, brand, tags, occasion, page, limit: limitStr, type, material, cards } = req.query as Record<string, string>
    const rawCategory = req.query.category
    const categories: string[] = Array.isArray(rawCategory)
      ? (rawCategory as string[]).filter(Boolean)
      : rawCategory ? [rawCategory as string] : []
    const pageNum = Math.max(1, parseInt(page ?? '1', 10))
    const pageSize = Math.min(100, Math.max(1, parseInt(limitStr ?? '10', 10)))
    const useCards = cards === 'true'

    const filterParams = {
      categories: categories.length ? categories : undefined,
      color: color || undefined,
      season: season || undefined,
      brand: brand || undefined,
      occasion: occasion || undefined,
      tags: tags ? tags.split(',').filter(Boolean) : undefined,
      subcategory: type || undefined,
      material: material || undefined,
    }

    const listFn = useCards ? listItemCards : listItems
    const [items, total] = await Promise.all([
      listFn({
        ...filterParams,
        limit: pageSize,
        offset: (pageNum - 1) * pageSize,
      }, userId),
      countItems(filterParams, userId),
    ])

    res.json({ items, total, page: pageNum, pageSize })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/items/meta
router.get('/meta', async (req, res) => {
  try {
    const userId = req.userId!
    const categories = getUniqueCategories(userId)
    res.json({ categories })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/items/:id
router.get('/:id', async (req, res) => {
  try {
    const item = await getItem(req.params.id, req.userId!)
    if (!item) return res.status(404).json({ error: 'Not found' })
    res.json(item)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/analyze
router.post('/analyze', categorizeLimiter, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    // Compress before the AI call (max 1200px, JPEG 80): the raw upload can be
    // up to 15 MB, and its base64 copy would be ~20 MB in memory and on the wire.
    const base64 = (await compressBuffer(req.file.buffer)).toString('base64')
    const existingTags = getUniqueTags(userId)
    const existingSubcategories = getUniqueSubcategories(userId)
    const classification = await runInstrumented({
      userId,
      task: 'categorize',
      model: VISION_MODEL,
      expectedBilledTokens: 0,
      call: async (_ctx) => {
        const { data, usage } = await categorizeItem(base64, existingTags, existingSubcategories)
        return { result: data, usage }
      },
    })
    res.json(classification)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items — add item
//
// Optional `Idempotency-Key` header (#347 / #349): a retry with the same key
// after a lost response replays the first item (200 + Idempotent-Replayed)
// instead of saving a duplicate. A concurrent request with the key gets 409.
router.post('/', saveLimiter, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    const idempotencyKey = req.get('Idempotency-Key')
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Invalid Idempotency-Key' })
    }
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const base64 = req.file.buffer.toString('base64')
    const body = req.body as Record<string, string>

    const candidate = {
      imageBase64: base64,
      autoAnalyze: false,
      category: body.category || undefined,
      subcategory: body.subcategory || undefined,
      primaryColor: body.primaryColor || undefined,
      colors: body.colors || undefined,
      material: body.material || undefined,
      brand: body.brand || undefined,
      size: body.size || undefined,
      season: body.season || undefined,
      tags: body.tags || undefined,
      occasion: body.occasion || undefined,
      aiDescription: body.aiDescription || undefined,
      careInstructions: body.careInstructions || undefined,
      wearContext: body.wearContext || undefined,
    }

    const parsed = AddItemInputSchema.safeParse(candidate)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }

    let token: string | undefined
    if (idempotencyKey) {
      const claim = claimItemCreateKey(userId, idempotencyKey)
      if (claim.kind === 'in_progress') {
        return res.status(409).json({ error: 'A save with this key is already in progress', code: 'IDEMPOTENCY_IN_PROGRESS' })
      }
      if (claim.kind === 'replay') {
        const existing = await getItem(claim.itemId, userId)
        if (existing) {
          res.set('Idempotent-Replayed', 'true')
          return res.status(200).json(existing)
        }
      } else {
        token = claim.token
      }
    }

    let item: Awaited<ReturnType<typeof addItem>>['item']
    try {
      item = (await addItem(parsed.data, userId)).item
    } catch (err) {
      if (idempotencyKey && token) releaseItemCreateKey(userId, idempotencyKey, token)
      throw err
    }
    if (idempotencyKey && token && !completeItemCreateKey(userId, idempotencyKey, token, item.id)) {
      console.warn('[items] idempotency lease was taken over before completion', { userId })
    }

    res.status(201).json(item)

    runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'multimodalembedding@001', fn: () => embedItemOnSave(item, userId) })
    runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'gemini-embedding-001', fn: () => embedItemTextOnSave(item), tokensIn: Math.ceil(textItemSourceBlob(item).length / 4) })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/items/:id
router.patch('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    const body = req.body as Record<string, unknown>
    if (body.material && typeof body.material === 'string') {
      body.materialSource = 'manual'
    }
    const parsed = UpdateItemInputSchema.omit({ id: true }).safeParse(body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues })
    }
    const item = await updateItem(req.params.id, parsed.data, userId)
    res.json(item)

    runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'multimodalembedding@001', fn: () => embedItemOnSave(item, userId) })
    runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'gemini-embedding-001', fn: () => embedItemTextOnSave(item), tokensIn: Math.ceil(textItemSourceBlob(item).length / 4) })
  } catch (err) {
    const msg = String(err)
    if (msg.includes('not found')) return res.status(404).json({ error: 'Item not found' })
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/items/:id
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId!
    await deleteItem(req.params.id, userId)
    deleteEmbeddingsForItem(req.params.id, userId).catch(() => {})
    deleteTextEmbeddingsForItem(req.params.id, userId).catch(() => {})
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/:id/image
router.post('/:id/image', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const existing = await getItem(req.params.id as string, userId)
    if (!existing) return res.status(404).json({ error: 'Item not found' })
    const base64 = req.file.buffer.toString('base64')
    const imageUri = await saveImageFromBase64(base64, 'items', userId)
    const item = dbUpdateItem(req.params.id as string, userId, { imageUri })
    res.json(item)

    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'multimodalembedding@001', fn: () => embedItemOnSave(item, userId) })
    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'gemini-embedding-001', fn: () => embedItemTextOnSave(item), tokensIn: Math.ceil(textItemSourceBlob(item).length / 4) })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/:id/worn
router.post('/:id/worn', async (req, res) => {
  try {
    const item = await markWorn(req.params.id, req.userId!)
    res.json(item)
  } catch (err) {
    const msg = String(err)
    if (msg.includes('not found')) return res.status(404).json({ error: 'Item not found' })
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/:id/tag
router.post('/:id/tag', categorizeLimiter, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const itemId = String(req.params.id)
    const current = await getItem(itemId, userId)
    if (!current) return res.status(404).json({ error: 'Not found' })

    // Rate limit: count OCR scans this calendar month (UTC, #213)
    const now = Date.now()
    const monthStart = startOfUtcMonthMs(now)
    const scanCount = db.select({ count: aiCalls.id }).from(aiCalls)
      .where(and(
        eq(aiCalls.userId, userId),
        eq(aiCalls.task, 'ocr'),
        eq(aiCalls.success, 1),
        gte(aiCalls.createdAt, monthStart),
      ))
      .all().length

    if (scanCount >= OCR_MONTHLY_LIMIT) {
      const monthName = new Date(startOfNextUtcMonthMs(now)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
      return res.status(429).json({
        error: `Scan limit reached (${OCR_MONTHLY_LIMIT}/month). Resets on ${monthName} 1 (UTC).`,
      })
    }

    const base64 = req.file.buffer.toString('base64')
    const [tagImageUri, tagData] = await Promise.all([
      saveImageFromBase64(base64, 'tags', userId),
      runInstrumented({
        userId,
        task: 'ocr',
        model: VISION_MODEL,
        expectedBilledTokens: tokenCost('ocr'),
        call: async (_ctx) => {
          const { data, usage } = await scanTag(base64)
          return { result: data, usage }
        },
      }),
    ])

    const patch: Record<string, unknown> = { tagImageUri }
    if (tagData.brand && !current.brand) patch.brand = tagData.brand
    if (tagData.size && !current.size) patch.size = tagData.size
    if (tagData.material_composition) {
      patch.material = tagData.material_composition
      patch.materialSource = 'ocr'
    }
    if (tagData.care_instructions?.length) {
      patch.careInstructions = JSON.stringify(tagData.care_instructions)
    }

    const item = dbUpdateItem(itemId, userId, patch)
    res.json({ item, tagData })

    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'multimodalembedding@001', fn: () => embedItemOnSave(item, userId) })
    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'gemini-embedding-001', fn: () => embedItemTextOnSave(item), tokensIn: Math.ceil(textItemSourceBlob(item).length / 4) })
  } catch (err) {
    if (respondInsufficientTokens(err, res)) return
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/bulk-detect
// POST /api/items/source — multipart image → { sourceUri }. Stages a photo on
// the server without any AI call, for bulk add boxes drawn by hand (no
// bulk-detect ran, so there's no server copy to crop from). The photo is
// decoded and re-encoded server-side, so it works for formats the browser
// can't draw. Unreferenced staged photos are removed by the monthly sweep.
router.post('/source', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const compressed = await compressBuffer(req.file.buffer)
    const sourceUri = await saveImageFromBase64(compressed.toString('base64'), 'source', req.userId!)
    res.json({ sourceUri })
  } catch (err) {
    if (err instanceof UnsupportedImageError) return res.status(415).json({ error: err.message })
    console.error('[items/source] failed:', err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown error')
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/crop — { sourceUri, box } → JPEG. Bulk add's review step
// crops each detected box here from the source photo bulk-detect saved,
// instead of on a browser canvas (prod 2026-09-29: silent client crop failures
// left empty previews and nothing saved). Only the caller's own staged source
// photos; nothing is stored.
const CropBody = z.object({
  sourceUri: z.string().max(200).regex(/^images\/source\/[\w-]+\.jpg$/),
  box: z.object({
    x: z.number().min(0).max(100), y: z.number().min(0).max(100),
    w: z.number().gt(0).max(100), h: z.number().gt(0).max(100),
  }),
})
const cropLimiter = perUserRateLimit(60_000, 120)

router.post('/crop', cropLimiter, async (req, res) => {
  const parsed = CropBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid crop request' })
  try {
    const jpeg = await cropSourceBox(parsed.data.sourceUri, req.userId!, parsed.data.box)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(jpeg)
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT' || /Input file is missing/i.test(String(err))
    if (missing) return res.status(404).json({ error: 'Source photo not found' })
    console.error('[items/crop] failed:', err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown error')
    res.status(500).json({ error: errMsg(err) })
  }
})

router.post('/bulk-detect', categorizeLimiter, upload.single('image'), async (req, res) => {
  // The source image is saved before detection runs, and its URI only reaches
  // the client on success. Any failure after the save deletes it, or it stays
  // on disk unreferenced (#342).
  let sourceUri: string | undefined
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })

    const compressed = await compressBuffer(req.file.buffer)

    const base64 = compressed.toString('base64')
    sourceUri = await saveImageFromBase64(base64, 'source', userId)
    const { result: detections, cost } = await runInstrumentedDetailed({
      userId,
      task: 'detect',
      model: detectionModel(),
      expectedBilledTokens: tokenCost('detect'),
      call: async (ctx) => {
        const { data, usage } = await detectItems(base64, undefined, ctx.openrouterKey)
        return { result: data, usage }
      },
    })

    res.json({ sourceUri, detections, cost })
  } catch (err) {
    if (sourceUri) {
      const staged = sourceUri
      await deleteImage(staged, req.userId!).catch(cleanupErr => {
        console.error('[bulk-detect] failed to delete staged source image', staged, cleanupErr)
      })
    }
    if (respondInsufficientTokens(err, res)) return
    // Failures were silent in the logs (a model-output parse error in prod, 2026-09-28).
    console.error('[bulk-detect] failed:', err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown error')
    res.status(500).json({ error: errMsg(err) })
  }
})

// GET /api/items/:id/images
router.get('/:id/images', async (req, res) => {
  try {
    const userId = req.userId!
    const item = await getItem(req.params.id, userId)
    if (!item) return res.status(404).json({ error: 'Item not found' })
    res.json(getItemImages(req.params.id, userId))
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/:id/images
router.post('/:id/images', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })

    const item = await getItem(req.params.id as string, userId)
    if (!item) return res.status(404).json({ error: 'Item not found' })

    const existing = getItemImages(req.params.id as string, userId)
    if (existing.length >= 4) return res.status(400).json({ error: 'Maximum 4 images per item' })

    const base64 = req.file.buffer.toString('base64')
    const imageUri = await saveImageFromBase64(base64, 'items', userId)
    const view = typeof req.body.view === 'string' ? req.body.view : null

    const image = insertItemImage({
      userId,
      itemId: req.params.id as string,
      imageUri,
      role: 'reference',
      view,
      isPrimary: existing.length === 0 ? 1 : 0,
      position: existing.length,
    })

    if (image.isPrimary) {
      setItemImagePrimary(req.params.id as string, image.id, userId)
      await dbUpdateItem(req.params.id as string, userId, { imageUri: image.imageUri, updatedAt: Date.now() })
    }

    res.status(201).json(image)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/items/:id/images/:imageId
router.delete('/:id/images/:imageId', async (req, res) => {
  try {
    const userId = req.userId!
    const item = await getItem(req.params.id, userId)
    if (!item) return res.status(404).json({ error: 'Item not found' })

    const img = getItemImage(req.params.imageId, userId)
    if (!img || img.itemId !== req.params.id) return res.status(404).json({ error: 'Image not found' })

    const all = getItemImages(req.params.id, userId)
    if (all.length <= 1) return res.status(400).json({ error: 'Cannot delete the only image' })

    await deleteImage(img.imageUri, userId)
    deleteItemImage(img.id, userId)

    if (img.isPrimary) {
      const remaining = getItemImages(req.params.id, userId)
      if (remaining.length > 0) {
        setItemImagePrimary(req.params.id, remaining[0].id, userId)
        await dbUpdateItem(req.params.id, userId, { imageUri: remaining[0].imageUri, updatedAt: Date.now() })
      }
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/items/:id/images/:imageId/primary
router.patch('/:id/images/:imageId/primary', async (req, res) => {
  try {
    const userId = req.userId!
    const owner = await getItem(req.params.id, userId)
    if (!owner) return res.status(404).json({ error: 'Item not found' })

    const img = getItemImage(req.params.imageId, userId)
    if (!img || img.itemId !== req.params.id) return res.status(404).json({ error: 'Image not found' })

    setItemImagePrimary(req.params.id, img.id, userId)
    const item = dbUpdateItem(req.params.id as string, userId, { imageUri: img.imageUri, updatedAt: Date.now() })
    res.json(img)

    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'multimodalembedding@001', fn: () => embedItemOnSave(item, userId) })
    if (item) runEmbeddingInstrumented({ userId, task: 'embed_item', model: 'gemini-embedding-001', fn: () => embedItemTextOnSave(item), tokensIn: Math.ceil(textItemSourceBlob(item).length / 4) })
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/items/:id/thumbnail
router.post('/:id/thumbnail', async (req, res) => {
  const { instruction, sourceImageIds } = req.body as { instruction?: string; sourceImageIds?: string[] }
  let sources: ReturnType<typeof getItemImages> = []
  try {
    const userId = req.userId!
    const item = await getItem(req.params.id, userId)
    if (!item) return res.status(404).json({ error: 'Item not found' })

    const allImages = getItemImages(req.params.id, userId)
    sources = sourceImageIds?.length
      ? allImages.filter(img => sourceImageIds.includes(img.id))
      : allImages.filter(img => img.role !== 'generated')

    if (sources.length === 0 && item.imageUri) {
      const backfilled = insertItemImage({
        userId,
        itemId: item.id,
        imageUri: item.imageUri,
        role: 'reference',
        isPrimary: allImages.length === 0 ? 1 : 0,
        position: allImages.length,
      })
      sources = [backfilled]
    }

    if (sources.length === 0) {
      return res.status(400).json({ error: 'No reference images available' })
    }

    // #352 — a local image model takes fewer references (Qwen-Image-2.1: 4).
    // An explicit pick over the limit is refused; the automatic set is cut to
    // the primary view plus the first others.
    const maxRefs = isLocalImageGen() ? imageGenMaxRefs() : MAX_REF_IMAGES
    if (sources.length > maxRefs) {
      if (sourceImageIds?.length || !isLocalImageGen()) {
        return res.status(400).json({
          error: `Maximum ${maxRefs} reference images per generation. You selected ${sources.length}. Pick your best shots.`,
        })
      }
      sources = [...sources].sort((a, b) => b.isPrimary - a.isPrimary).slice(0, maxRefs)
    }

    const base64s = await Promise.all(sources.map(img => imageToBase64(img.imageUri, userId)))

    const totalBytes = base64s.reduce((sum, b) => sum + Math.floor(b.length * 0.75), 0)
    if (totalBytes > MAX_REF_BYTES) {
      const mb = (totalBytes / 1024 / 1024).toFixed(1)
      return res.status(400).json({
        error: `Total reference image size exceeds 10MB (${mb}MB). Try selecting fewer or higher-compression photos.`,
      })
    }
    const itemContext = [item.category, item.subcategory, item.primaryColor, item.material, item.brand]
      .filter(Boolean).join(' · ')
    const fullInstruction = [itemContext && `Item: ${itemContext}`, instruction].filter(Boolean).join('\n') || undefined
    let heroCallId: string | undefined
    const generatedUri = await runInstrumented({
      userId,
      task: 'make_pretty',
      model: imageGenModel(),
      itemId: item.id,
      expectedBilledTokens: tokenCost('make_pretty'),
      mocked: isMockImageGen(),
      onCallRecorded: (id) => { heroCallId = id },
      call: async (_ctx) => ({
        result: await generateHeroImage(base64s, userId, fullInstruction),
      }),
    })

    if (heroCallId) {
      updateAiCallLinks(heroCallId, { outputImageUri: generatedUri })
    }

    const position = allImages.length
    const image = insertItemImage({
      userId: req.userId!,
      itemId: item.id,
      imageUri: generatedUri,
      role: 'generated',
      isPrimary: 0,
      position,
    })

    res.status(201).json({ image, imageUri: generatedUri })
  } catch (err) {
    if (respondInsufficientTokens(err, res)) return
    if (err instanceof ImageGenUserBusyError) return res.status(429).json({ error: err.message })
    console.error('[thumbnail] generation failed', {
      message: (err as Error)?.message,
      stack: (err as Error)?.stack,
      response: (err as any)?.response?.data,
      status: (err as any)?.status || (err as any)?.response?.status,
      itemId: req.params.id,
      sourceCount: sources.length,
      hasInstruction: !!instruction,
    })
    res.status(500).json({ error: errMsg(err) })
  }
})

export default router
