import { describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import { IMAGE_UPLOAD_LIMITS, imageUpload, uploadErrorResponse } from '../../../src/transport/web/upload.js'
import shareTargetRouter from '../../../src/transport/web/routes/shareTarget.js'

// OSS audit 2026-09-28 — multipart bodies are capped beyond file size:
// one file, 30 fields of at most 64 KB. Rejections are 400/413, not 500.

function app() {
  const a = express()
  const upload = imageUpload()
  a.post('/up', upload.single('image'), (_req, res) => { res.json({ ok: true }) })
  a.use('/share-target', shareTargetRouter)
  a.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const r = uploadErrorResponse(err)
    if (r) { res.status(r.status).json(r.body); return }
    next(err)
  })
  return a
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC', 'base64')

describe('image upload limits', () => {
  it('a normal upload with a few fields passes', async () => {
    await request(app()).post('/up').field('tags', '["a"]').attach('image', png, 'a.png').expect(200)
  })

  it('too many fields → 400', async () => {
    let req = request(app()).post('/up')
    for (let i = 0; i <= IMAGE_UPLOAD_LIMITS.fields; i++) req = req.field(`f${i}`, 'x')
    const res = await req.attach('image', png, 'a.png')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'upload_rejected' })
  })

  it('an oversized field → 400', async () => {
    const res = await request(app()).post('/up').field('big', 'x'.repeat(IMAGE_UPLOAD_LIMITS.fieldSize + 1)).attach('image', png, 'a.png')
    expect(res.status).toBe(400)
  })

  it('a second file → 400', async () => {
    const res = await request(app()).post('/up').attach('image', png, 'a.png').attach('image', png, 'b.png')
    expect(res.status).toBe(400)
  })

  it('an oversized file → 413', async () => {
    const res = await request(app()).post('/up').attach('image', Buffer.alloc(IMAGE_UPLOAD_LIMITS.fileSize + 1), 'big.png')
    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'file_too_large' })
  })

  it('the anonymous /share-target refuses a field flood', async () => {
    let req = request(app()).post('/share-target')
    for (let i = 0; i < 60; i++) req = req.field(`f${i}`, 'x'.repeat(1000))
    const res = await req.attach('image', png, 'a.png')
    expect(res.status).toBe(400)
  })
})
