import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn((input: any) => input.call({}).then((r: any) => r.result)),
}))

vi.mock('../../../../src/tools/items.js', () => ({
  listItems: vi.fn(),
}))
vi.mock('../../../../src/tools/outfits.js', () => ({
  listOutfits: vi.fn(),
}))
vi.mock('../../../../src/tools/weather.js', () => ({
  getCurrentWeather: vi.fn(),
}))
vi.mock('../../../../src/tools/share.js', () => ({
  getSharePayload: vi.fn(),
}))
vi.mock('../../../../src/ai/inspiration.js', () => ({
  analyzeInspiration: vi.fn(),
}))
vi.mock('../../../../src/ai/discover.js', () => ({
  matchClosetToContext: vi.fn().mockResolvedValue({ data: [], usage: { tokensIn: 0, tokensOut: 0 } }),
}))
vi.mock('../../../../src/ai/embed.js', () => ({
  embedText: vi.fn(),
}))
vi.mock('../../../../src/ai/embedImage.js', () => ({
  embedImage: vi.fn(),
  embedItemImage: vi.fn(),
}))
vi.mock('../../../../src/ai/discoverEvents.js', () => ({
  logDiscoverEvent: vi.fn(),
}))
vi.mock('../../../../src/storage/embeddings.js', () => ({
  topKHybrid: vi.fn(),
  shouldUsePreFilter: vi.fn().mockReturnValue(false),
  getAllEmbeddings: vi.fn().mockReturnValue(new Map()),
  topKText: vi.fn(),
  topKImageFromBuffer: vi.fn(),
}))

import * as itemsTools from '../../../../src/tools/items.js'
import * as inspiration from '../../../../src/ai/inspiration.js'
import discoverRouter from '../../../../src/transport/web/routes/discover.js'

function makeApp() {
  const app = express()
  app.use('/', discoverRouter)
  return app
}

const app = makeApp()

describe('POST /api/discover (multipart)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(itemsTools.listItems).mockResolvedValue([
      { id: 'item-1', category: 'tops' } as any,
      { id: 'item-2', category: 'bottoms' } as any,
    ])
    vi.mocked(inspiration.analyzeInspiration).mockResolvedValue({
      data: {
        description: 'A blue shirt',
        vibe: 'casual',
        dominantColors: ['blue', 'white'],
      },
      usage: { tokensIn: 100, tokensOut: 50 },
    })
  })

  it('accepts image via multipart form-data', async () => {
    const res = await request(app)
      .post('/')
      .field('mode', 'image')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')

    expect(res.status).toBe(200)
  })

  it('returns 400 when image mode has no file', async () => {
    const res = await request(app)
      .post('/')
      .field('mode', 'image')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No image provided')
  })

  it('accepts coordinates as coerced numbers in multipart mode', async () => {
    const res = await request(app)
      .post('/')
      .field('mode', 'image')
      .field('lat', '40.7128')
      .field('lon', '-74.006')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')

    expect(res.status).toBe(200)
  })
})

describe('POST /api/discover/stream (multipart)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(itemsTools.listItems).mockResolvedValue([
      { id: 'item-1', category: 'tops' } as any,
      { id: 'item-2', category: 'bottoms' } as any,
    ])
    vi.mocked(inspiration.analyzeInspiration).mockResolvedValue({
      data: {
        description: 'A blue shirt',
        vibe: 'casual',
        dominantColors: ['blue', 'white'],
      },
      usage: { tokensIn: 100, tokensOut: 50 },
    })
  })

  it('accepts image via multipart in stream mode', async () => {
    const res = await request(app)
      .post('/stream')
      .field('mode', 'image')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')

    // Stream endpoint returns 200 and sends SSE events
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
  })

  it('returns SSE error when image mode has no file in stream', async () => {
    const res = await request(app)
      .post('/stream')
      .field('mode', 'image')

    expect(res.status).toBe(200) // SSE still returns 200
    expect(res.text).toContain('event: error')
    expect(res.text).toContain('No image provided')
  })
})
