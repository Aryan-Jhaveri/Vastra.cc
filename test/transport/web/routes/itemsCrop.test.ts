import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import sharp from 'sharp'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { DATA_DIR } from '../../../../src/db/client.js'

// Prod 2026-09-29 — bulk add crops detected boxes on the server from the
// photo bulk-detect saved (the browser canvas crop failed silently: empty
// previews, nothing classified or saved). Own photos only; nothing stored.

vi.mock('../../../../src/ai/instrumented.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/ai/instrumented.js')>(),
  runEmbeddingInstrumented: vi.fn(),
}))

import itemsRouter from '../../../../src/transport/web/routes/items.js'

const A = 'user_crop_a'
const B = 'user_crop_b'
const URI = 'images/source/photo1.jpg'

function app(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.userId = userId; next() })
  a.use('/api/items', itemsRouter)
  return a
}

beforeAll(async () => {
  // 400×200: left half red, right half blue.
  const dir = join(DATA_DIR, 'users', A, 'images', 'source')
  mkdirSync(dir, { recursive: true })
  const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer()
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }]).jpeg({ quality: 95 }).toFile(join(dir, 'photo1.jpg'))
})
afterAll(() => { rmSync(join(DATA_DIR, 'users', A), { recursive: true, force: true }) })

async function bytes(res: request.Response): Promise<Buffer> {
  return res.body as Buffer
}

describe('POST /api/items/crop', () => {
  it('returns the box as a JPEG cut from the right region', async () => {
    const res = await request(app(A)).post('/api/items/crop')
      .send({ sourceUri: URI, box: { x: 50, y: 0, w: 50, h: 100 } })
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))) })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    const img = sharp(await bytes(res))
    const meta = await img.metadata()
    expect(meta.format).toBe('jpeg')
    const { dominant } = await img.stats()
    expect(dominant.b).toBeGreaterThan(200) // the blue half
    expect(dominant.r).toBeLessThan(60)
  })

  it("another user's source photo is a 404, never their image", async () => {
    const res = await request(app(B)).post('/api/items/crop').send({ sourceUri: URI, box: { x: 0, y: 0, w: 50, h: 50 } })
    expect(res.status).toBe(404)
  })

  it.each([
    [{ sourceUri: '../users/user_crop_a/images/source/photo1.jpg', box: { x: 0, y: 0, w: 10, h: 10 } }],
    [{ sourceUri: 'images/items/x.jpg', box: { x: 0, y: 0, w: 10, h: 10 } }],
    [{ sourceUri: URI, box: { x: 0, y: 0, w: 0, h: 10 } }],
    [{ sourceUri: URI, box: { x: -5, y: 0, w: 10, h: 10 } }],
    [{ sourceUri: URI }],
  ])('rejects %j', async body => {
    expect((await request(app(A)).post('/api/items/crop').send(body)).status).toBe(400)
  })
})

describe('POST /api/items/source (hand-drawn boxes)', () => {
  it('stages a photo under the caller\'s own folder and returns its sourceUri, which /crop accepts', async () => {
    const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#00ff00' } }).png().toBuffer()
    const res = await request(app(A)).post('/api/items/source').attach('image', png, 'p.png')
    expect(res.status).toBe(200)
    expect(res.body.sourceUri).toMatch(/^images\/source\/[\w-]+\.jpg$/)
    const { existsSync } = await import('fs')
    expect(existsSync(join(DATA_DIR, 'users', A, res.body.sourceUri))).toBe(true)
    const crop = await request(app(A)).post('/api/items/crop').send({ sourceUri: res.body.sourceUri, box: { x: 0, y: 0, w: 100, h: 100 } })
    expect(crop.status).toBe(200)
  })

  it('refuses a format the server won\'t decode (SVG) with 415', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>')
    const res = await request(app(A)).post('/api/items/source').attach('image', svg, { filename: 'x.svg', contentType: 'image/svg+xml' })
    expect(res.status).toBe(415)
  })
})
