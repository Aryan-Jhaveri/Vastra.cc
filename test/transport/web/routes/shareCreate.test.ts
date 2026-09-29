import { describe, expect, it, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// OSS audit 2026-09-28 — each share image is written to disk, so the list is
// de-duplicated and capped before anything is snapshotted.

const { createSharePayload } = vi.hoisted(() => ({ createSharePayload: vi.fn() }))
vi.mock('../../../../src/tools/share.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/tools/share.js')>(),
  createSharePayload,
}))
vi.mock('../../../../src/ai/instrumented.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/ai/instrumented.js')>(),
  runEmbeddingInstrumented: vi.fn(),
}))

import shareRouter, { MAX_SHARE_IMAGES } from '../../../../src/transport/web/routes/share.js'

function app() {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.userId = 'user_share_cap'; next() })
  a.use('/api/share', shareRouter)
  return a
}

beforeEach(() => {
  createSharePayload.mockReset()
  createSharePayload.mockResolvedValue({ id: 'sh1', description: 'd' })
})

describe('POST /api/share image limits', () => {
  it('repeats of one image collapse to one snapshot', async () => {
    const uri = 'images/items/a.jpg'
    await request(app()).post('/api/share').send({ source: 'outfit', description: 'd', imageUris: Array(40).fill(uri) }).expect(201)
    expect(createSharePayload.mock.calls[0][0].imageUris).toEqual([uri])
  })

  it(`more than ${MAX_SHARE_IMAGES} distinct images is a 400 and nothing is written`, async () => {
    const uris = Array.from({ length: MAX_SHARE_IMAGES + 1 }, (_, i) => `images/items/${i}.jpg`)
    await request(app()).post('/api/share').send({ source: 'outfit', description: 'd', imageUris: uris }).expect(400)
    expect(createSharePayload).not.toHaveBeenCalled()
  })

  it('a huge list is refused outright', async () => {
    await request(app()).post('/api/share').send({ source: 'outfit', description: 'd', imageUris: Array(2400).fill('images/items/a.jpg') }).expect(400)
    expect(createSharePayload).not.toHaveBeenCalled()
  })
})
