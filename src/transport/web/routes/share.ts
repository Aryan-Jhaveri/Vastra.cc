import { Router } from 'express'
import { z } from 'zod'
import { createSharePayload, getSharePayload, deleteSharePayload, markShareOpened, listMySharePayloads, claimSharePayload } from '../../../tools/share.js'
import { getOutfit } from '../../../tools/outfits.js'
import { getUser } from '../../../db/queries.js'
import { moveImageBetweenUsers } from '../../../storage/images.js'
import { embedShareImageOnSave, deleteEmbeddingsForShare } from '../../../ai/embedImage.js'
import { embedShareTextOnSave, deleteTextEmbeddingsForShare } from '../../../ai/embed.js'
import { runEmbeddingInstrumented } from '../../../ai/instrumented.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'

const router = Router()

// Each image URI becomes a new JPEG on disk, so the list is bounded and
// de-duplicated (OSS audit 2026-09-28: 2,400 repeats fit in one 100 KB body).
export const MAX_SHARE_IMAGES = 12

const CreateShareSchema = z.object({
  source: z.enum(['outfit', 'suggestion', 'inspiration', 'manual']),
  sourceRef: z.string().max(100).optional(),
  description: z.string().min(1).max(1000),
  imageUris: z.array(z.string().max(300)).max(MAX_SHARE_IMAGES * 4).optional()
    .transform(uris => (uris ? [...new Set(uris)] : uris))
    .refine(uris => !uris || uris.length <= MAX_SHARE_IMAGES, `At most ${MAX_SHARE_IMAGES} images`),
  senderHandle: z.string().max(100).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})

const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:3000'

// GET /api/share — list all share payloads created by this user
router.get('/', (req, res) => {
  try {
    const userId = req.userId!
    const payloads = listMySharePayloads(userId)
    res.json(payloads.map(p => ({
      id: p.id,
      source: p.source,
      description: p.description,
      imageUris: (() => { try { return JSON.parse(p.imageUris ?? '[]') } catch { return [] } })(),
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      openCount: p.openCount,
      url: `${BASE_URL}/share/${p.id}`,
    })))
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

const createLimiter = perUserRateLimit(60_000, 20)

// POST /api/share
router.post('/', createLimiter, async (req, res) => {
  const parsed = CreateShareSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const userId = req.userId!
    const payload = await createSharePayload(parsed.data, userId)
    res.status(201).json({ id: payload.id, url: `${BASE_URL}/share/${payload.id}` })

    runEmbeddingInstrumented({ userId, task: 'embed_share', provider: 'vertex', model: 'multimodalembedding@001', fn: () => embedShareImageOnSave(payload, userId) })
    runEmbeddingInstrumented({ userId, task: 'embed_share', provider: 'gemini', model: 'gemini-embedding-001', fn: () => embedShareTextOnSave({ ...payload, userId }), tokensIn: Math.ceil(payload.description.length / 4) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/share/:id — public snapshot read (marks opened)
router.get('/:id', async (req, res) => {
  const payload = getSharePayload(req.params.id)
  if (!payload) return res.status(404).json({ error: 'Share not found' })

  // Check expiry
  if (payload.expiresAt && payload.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Share has expired' })
  }

  // Mark as opened (fire-and-forget)
  try { markShareOpened(req.params.id) } catch { /* non-critical */ }

  const imageUris: string[] = (() => {
    try { return JSON.parse(payload.imageUris ?? '[]') as string[] }
    catch { return [] }
  })()

  // Optionally attach source outfit for context
  let outfit = null
  if (payload.source === 'outfit' && payload.sourceRef) {
    try { outfit = await getOutfit(payload.sourceRef, payload.userId) } catch { /* optional */ }
  }

  // Surface the sender's account name when set, so the preview card can
  // render "From <name>" instead of falling back to "Someone".
  let senderName: string | null = null
  try {
    const sender = getUser(payload.createdByUserId ?? payload.userId)
    senderName = sender?.name?.trim() || null
  } catch { /* optional */ }

  res.json({
    id: payload.id,
    source: payload.source,
    description: payload.description,
    imageUris,
    senderHandle: payload.senderHandle,
    senderName,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    outfit: outfit ?? null,
  })
})

// POST /api/share/:id/claim — a freshly-logged-in user adopts an anonymous
// share_inbox row that was created before they authenticated. Auth-guarded.
const ClaimSchema = z.object({ claimToken: z.string().min(1) })
const CLAIM_EXTEND_MS = 30 * 24 * 60 * 60 * 1000

router.post('/:id/claim', async (req, res) => {
  const parsed = ClaimSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const userId = req.userId!
  const payload = getSharePayload(req.params.id)

  // Don't leak existence: anything other than a matching anonymous + token row is 404.
  if (!payload || payload.userId !== '__anon__' || payload.claimToken !== parsed.data.claimToken) {
    return res.status(404).json({ error: 'Share not found' })
  }
  if (payload.expiresAt && payload.expiresAt < Date.now()) {
    return res.status(410).json({ error: 'Share has expired' })
  }

  try {
    const imageUris: string[] = (() => {
      try { return JSON.parse(payload.imageUris ?? '[]') as string[] }
      catch { return [] }
    })()
    // Relocate the bytes from the anon tree into the claimer's tree. The DB-relative
    // URI is unchanged (only the resolving userId differs), so imageUris is NOT
    // rewritten — we move the file then flip ownership.
    // Claim the row first (atomic); only the winner relocates the files.
    if (!claimSharePayload(req.params.id, parsed.data.claimToken, userId, Date.now() + CLAIM_EXTEND_MS)) {
      return res.status(404).json({ error: 'Share not found' })
    }
    for (const uri of imageUris) {
      await moveImageBetweenUsers(uri, '__anon__', userId)
    }
    res.json({ id: payload.id, redirect: `/?share=${payload.id}&kind=inbox` })
  } catch (err) {
    console.error('[share claim]', err)
    res.status(500).json({ error: 'Could not claim share' })
  }
})

// DELETE /api/share/:id — sender revokes.
// Reads are public by link, but revocation is restricted to the creator.
router.delete('/:id', (req, res) => {
  const userId = req.userId!
  const payload = getSharePayload(req.params.id)
  if (!payload || payload.createdByUserId !== userId) {
    return res.status(404).json({ error: 'Share not found' })
  }
  deleteSharePayload(req.params.id)
  deleteEmbeddingsForShare(req.params.id, userId).catch(() => {})
  deleteTextEmbeddingsForShare(req.params.id, userId).catch(() => {})
  res.status(204).send()
})

export default router
