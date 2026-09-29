import { Router } from 'express'
import { imageUpload, uploadRateLimit } from '../upload.js'
import * as queries from '../../../db/queries.js'
import { saveImageFromBase64 } from '../../../storage/images.js'

const router = Router()
const upload = imageUpload()

const isProd = process.env.NODE_ENV === 'production'
const errMsg = (err: unknown) => isProd ? 'Internal server error' : String(err)

// GET /api/user-photos
router.get('/', (req, res) => {
  try {
    const userId = req.userId!
    const photos = queries.getUserPhotos(userId)
    res.json(photos)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// POST /api/user-photos
router.post('/', uploadRateLimit, upload.single('image'), async (req, res) => {
  try {
    const userId = req.userId!
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' })
    const base64 = req.file.buffer.toString('base64')
    const { label, isPrimary } = req.body as { label?: string; isPrimary?: string }

    const imageUri = await saveImageFromBase64(base64, 'user', userId)

    // First photo is automatically primary unless specified otherwise
    const existingPhotos = queries.getUserPhotos(userId)
    const makePrimary = isPrimary === 'true' || existingPhotos.length === 0

    const photo = queries.insertUserPhoto({
      userId,
      imageUri,
      label: label || undefined,
      isPrimary: makePrimary ? 1 : 0,
    })

    // If marking primary, use setPrimaryPhoto to ensure only one is set
    if (makePrimary) {
      queries.setPrimaryPhoto(photo.id, userId)
    }

    res.status(201).json(photo)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// PATCH /api/user-photos/:id/primary
router.patch('/:id/primary', (req, res) => {
  try {
    const userId = req.userId!
    const photo = queries.setPrimaryPhoto(req.params.id, userId)
    if (!photo) return res.status(404).json({ error: 'Not found' })
    res.json(photo)
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

// DELETE /api/user-photos/:id
router.delete('/:id', (req, res) => {
  try {
    const userId = req.userId!
    queries.deleteUserPhoto(req.params.id, userId)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: errMsg(err) })
  }
})

export default router
