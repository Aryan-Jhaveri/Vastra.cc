import { describe, it, expect, vi, beforeEach, afterAll, onTestFinished } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn((input: any) => input.call({}).then((r: any) => r.result)),
  runInstrumentedDetailed: vi.fn(async (input: any) => {
    const { result, usage } = await input.call({})
    return {
      result,
      cost: {
        billedTokens: input.expectedBilledTokens,
        wholesaleCostCentsX100: 40,
        tokensIn: usage?.tokensIn ?? 500,
        tokensOut: usage?.tokensOut ?? 100,
      },
    }
  }),
  runEmbeddingInstrumented: vi.fn(),
  isMockImageGen: vi.fn(() => false),
}))

vi.mock('../../../../src/tools/items.js', () => ({
  listItems: vi.fn(),
  countItems: vi.fn(),
  listItemCards: vi.fn(),
  getItem: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  markWorn: vi.fn(),
}))

vi.mock('../../../../src/db/itemCreateKeys.js', () => ({
  IDEMPOTENCY_KEY_RE: /^[A-Za-z0-9_-]{8,128}$/,
  claimItemCreateKey: vi.fn(() => ({ kind: 'claimed', token: 'tok' })),
  completeItemCreateKey: vi.fn(() => true),
  releaseItemCreateKey: vi.fn(),
}))

vi.mock('../../../../src/ai/categorize.js', () => ({
  categorizeItem: vi.fn(),
}))

vi.mock('../../../../src/ai/scanTag.js', () => ({
  scanTag: vi.fn(),
}))

vi.mock('../../../../src/ai/detectItems.js', () => ({
  detectItems: vi.fn().mockResolvedValue({
    data: [
      { id: 'd1', label: 'Blue jacket', category: 'outerwear', cropColor: '#d4e8d4', box: { x: 10, y: 10, w: 30, h: 40 }, kept: true, alternatives: [] },
    ],
    usage: { tokensIn: 500, tokensOut: 100 },
  }),
}))

vi.mock('../../../../src/storage/images.js', () => ({
  saveImageFromBase64: vi.fn(),
  deleteImage: vi.fn(async () => {}),
  compressBuffer: vi.fn(async (buf: Buffer) => buf),
  cropFromUri: vi.fn(async () => 'images/items/cropped.jpg'),
  imageToBase64: vi.fn(async () => 'base64data'),
  getImageMetadata: vi.fn(async () => ({ width: 1000, height: 1000 })),
}))

vi.mock('../../../../src/db/queries.js', () => ({
  updateItem: vi.fn(),
  getUniqueTags: vi.fn().mockReturnValue([]),
  getUniqueSubcategories: vi.fn().mockReturnValue([]),
  getItemImages: vi.fn(),
  insertItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
  getItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
}))

import * as itemsTools from '../../../../src/tools/items.js'
import * as categorize from '../../../../src/ai/categorize.js'
import * as scanTagMod from '../../../../src/ai/scanTag.js'
import * as imageStorage from '../../../../src/storage/images.js'
import * as queries from '../../../../src/db/queries.js'
import { db } from '../../../../src/db/client.js'
import { aiCalls } from '../../../../src/db/schema.js'
import { sql } from 'drizzle-orm'
import * as createKeys from '../../../../src/db/itemCreateKeys.js'
import itemsRouter from '../../../../src/transport/web/routes/items.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', itemsRouter)
  return app
}

function makeAppWithAuth() {
  const app = express()
  app.use((req: any, _res, next) => { req.userId = 'self'; next() })
  app.use(express.json())
  app.use('/', itemsRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

const mockItem = {
  id: 'item1',
  imageUri: 'images/items/test.jpg',
  category: 'tops',
  subcategory: 'T-shirt',
  primaryColor: 'white',
  colors: '["white"]',
  timesWorn: 0,
  createdAt: Date.now(),
}

describe('GET /', () => {
  it('returns paginated items', async () => {
    vi.mocked(itemsTools.listItems).mockResolvedValue([mockItem] as any)
    vi.mocked(itemsTools.countItems).mockResolvedValue(1) as any
    const app = makeApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.total).toBe(1)
    expect(res.body.page).toBe(1)
  })

  it('passes category filter', async () => {
    vi.mocked(itemsTools.listItems).mockResolvedValue([])
    vi.mocked(itemsTools.countItems).mockResolvedValue(0) as any
    const app = makeApp()
    await request(app).get('/?category=tops')
    expect(itemsTools.listItems).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
    )
    expect((itemsTools.listItems as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveProperty('categories', ['tops'])
  })
})

describe('GET / — occasion filter (#216)', () => {
  const kokoItem = { ...mockItem, id: 'koko-item', occasion: '["koko"]' }
  const casualItem = { ...mockItem, id: 'casual-item', occasion: '["casual"]' }
  const otherUserKoko = { ...mockItem, id: 'other-user-koko', occasion: '["koko"]' }

  // Simulate the tool + SQL layer honouring both `occasion` and `userId`.
  const seeded = [
    { item: kokoItem, userId: 'self' },
    { item: casualItem, userId: 'self' },
    { item: otherUserKoko, userId: 'other' },
  ]
  function seedFilteredMocks() {
    const matches = (params: any, userId: any) =>
      seeded
        .filter((r) => r.userId === userId)
        .filter((r) => !params.occasion || JSON.parse(r.item.occasion).includes(params.occasion))
        .map((r) => r.item)
    vi.mocked(itemsTools.listItems).mockImplementation(((params: any, userId: any) =>
      Promise.resolve(matches(params, userId))) as any)
    vi.mocked(itemsTools.countItems).mockImplementation(((params: any, userId: any) =>
      Promise.resolve(matches(params, userId).length)) as any)
  }

  it('forwards occasion into filterParams (silently dropped before the fix)', async () => {
    vi.mocked(itemsTools.listItems).mockResolvedValue([])
    vi.mocked(itemsTools.countItems).mockResolvedValue(0) as any
    const app = makeAppWithAuth()
    await request(app).get('/?occasion=koko')
    expect((itemsTools.listItems as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveProperty('occasion', 'koko')
    expect((itemsTools.countItems as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveProperty('occasion', 'koko')
  })

  it('returns only the koko item and total === 1 when filtering occasion=koko', async () => {
    seedFilteredMocks()
    const app = makeAppWithAuth()
    const res = await request(app).get('/?occasion=koko')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].id).toBe('koko-item')
    expect(res.body.total).toBe(1)
  })

  it('does not leak another user\'s koko item (cross-user isolation)', async () => {
    seedFilteredMocks()
    const app = makeAppWithAuth()
    const res = await request(app).get('/?occasion=koko')
    expect(res.status).toBe(200)
    expect(res.body.items.map((i: any) => i.id)).not.toContain('other-user-koko')
    expect(res.body.total).toBe(1)
  })
})

describe('GET /:id', () => {
  it('returns 404 when item not found', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(null)
    const app = makeApp()
    const res = await request(app).get('/unknown')
    expect(res.status).toBe(404)
  })

  it('returns item', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    const app = makeApp()
    const res = await request(app).get('/item1')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('item1')
  })
})

describe('POST /analyze', () => {
  it('returns 400 when no file', async () => {
    const app = makeApp()
    const res = await request(app).post('/analyze')
    expect(res.status).toBe(400)
  })

  it('returns classification from file', async () => {
    const mockClassification = {
      category: 'tops',
      subcategory: 'T-shirt',
      primary_color: 'white',
      colors: ['white'],
      material: 'cotton',
      season: ['summer'],
      ai_description: 'A white t-shirt',
      suggested_tags: ['casual'],
    }
    vi.mocked(categorize.categorizeItem).mockResolvedValue({ data: mockClassification, usage: { tokensIn: 100, tokensOut: 50 } } as any)
    const app = makeApp()
    const res = await request(app)
      .post('/analyze')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
    expect(res.status).toBe(200)
    expect(res.body.category).toBe('tops')
  })

  it('compresses the upload before categorizing it', async () => {
    vi.mocked(categorize.categorizeItem).mockResolvedValue({ data: { category: 'tops' }, usage: { tokensIn: 1, tokensOut: 1 } } as any)
    vi.mocked(imageStorage.compressBuffer).mockResolvedValueOnce(Buffer.from('small-jpeg'))
    const app = makeApp()
    const res = await request(app)
      .post('/analyze')
      .attach('image', Buffer.from('raw-15mb-upload'), 'test.jpg')
    expect(res.status).toBe(200)
    expect(vi.mocked(imageStorage.compressBuffer).mock.calls.at(-1)?.[0].toString()).toBe('raw-15mb-upload')
    expect(vi.mocked(categorize.categorizeItem).mock.calls.at(-1)?.[0]).toBe(Buffer.from('small-jpeg').toString('base64'))
  })
})

// Bulk Add Item paces itself on 429 — the limiter must tell it how long to
// wait, and saves must not share (and be starved by) the classify budget.
describe('rate limits — bulk Add Item', () => {
  function appAs(userId: string) {
    const app = express()
    app.use((req: any, _res, next) => { req.userId = userId; next() })
    app.use('/', itemsRouter)
    return app
  }

  it('analyze and bulk-detect share a 30/min bucket and 429 with Retry-After; saves have their own', async () => {
    const prev = process.env.VITEST
    delete process.env.VITEST // the limiter skips itself under vitest
    try {
      const app = appAs('rl-bulk-user')
      for (let i = 0; i < 20; i++) expect((await request(app).post('/analyze')).status).toBe(400)
      for (let i = 0; i < 10; i++) expect((await request(app).post('/bulk-detect')).status).toBe(400)
      const limited = await request(app).post('/analyze')
      expect(limited.status).toBe(429)
      expect(limited.body.error).toBe('rate_limited')
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
      expect(limited.headers['ratelimit-limit']).toBe('30')
      expect((await request(app).post('/bulk-detect')).status).toBe(429)
      // The save bucket is untouched: 400 (no image), not 429.
      expect((await request(app).post('/')).status).toBe(400)
      // Other users are unaffected.
      expect((await request(appAs('rl-other-user')).post('/analyze')).status).toBe(400)
    } finally {
      process.env.VITEST = prev
    }
  })
})

describe('POST /', () => {
  it('returns 400 when no image', async () => {
    const app = makeApp()
    const res = await request(app).post('/')
    expect(res.status).toBe(400)
  })

  it('creates item with image', async () => {
    vi.mocked(itemsTools.addItem).mockResolvedValue({ item: mockItem } as any)
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('category', 'tops')
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('item1')
  })
})

// #347 / #349 — Idempotency-Key on POST /.
describe('POST / — idempotency key', () => {
  const KEY = '3f2b9c1e-idem-key-0001'
  const post = () => request(makeAppWithAuth()).post('/').set('Idempotency-Key', KEY)
    .attach('image', Buffer.from('fake-image'), 'test.jpg').field('category', 'tops')

  it('claims, creates, then records the item under the key', async () => {
    vi.mocked(itemsTools.addItem).mockResolvedValue({ item: mockItem } as any)
    const res = await post()
    expect(res.status).toBe(201)
    expect(createKeys.claimItemCreateKey).toHaveBeenCalledWith('self', KEY)
    expect(createKeys.completeItemCreateKey).toHaveBeenCalledWith('self', KEY, 'tok', 'item1')
  })

  it('replays the first item on a retry, without creating another', async () => {
    vi.mocked(createKeys.claimItemCreateKey).mockReturnValueOnce({ kind: 'replay', itemId: 'item1' })
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers['idempotent-replayed']).toBe('true')
    expect(res.body.id).toBe('item1')
    expect(itemsTools.addItem).not.toHaveBeenCalled()
    expect(itemsTools.getItem).toHaveBeenCalledWith('item1', 'self')
  })

  it('409 while another request with the key is in flight', async () => {
    vi.mocked(createKeys.claimItemCreateKey).mockReturnValueOnce({ kind: 'in_progress' })
    const res = await post()
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('IDEMPOTENCY_IN_PROGRESS')
    expect(itemsTools.addItem).not.toHaveBeenCalled()
  })

  it('releases the lease when creation fails so the client can retry', async () => {
    vi.mocked(itemsTools.addItem).mockRejectedValueOnce(new Error('disk full'))
    const res = await post()
    expect(res.status).toBe(500)
    expect(createKeys.releaseItemCreateKey).toHaveBeenCalledWith('self', KEY, 'tok')
    expect(createKeys.completeItemCreateKey).not.toHaveBeenCalled()
  })

  it('400 for a malformed key, before any claim', async () => {
    const res = await request(makeAppWithAuth()).post('/').set('Idempotency-Key', 'no spaces allowed')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
    expect(res.status).toBe(400)
    expect(createKeys.claimItemCreateKey).not.toHaveBeenCalled()
  })

  it('does not claim a key for invalid input', async () => {
    const res = await request(makeAppWithAuth()).post('/').set('Idempotency-Key', KEY)
      .attach('image', Buffer.from('fake-image'), 'test.jpg').field('tags', JSON.stringify(Array(200).fill('abcde')))
    expect(res.status).toBe(400)
    expect(createKeys.claimItemCreateKey).not.toHaveBeenCalled()
  })

  it('works without a key, as before', async () => {
    vi.mocked(itemsTools.addItem).mockResolvedValue({ item: mockItem } as any)
    const res = await request(makeAppWithAuth()).post('/').attach('image', Buffer.from('fake-image'), 'test.jpg')
    expect(res.status).toBe(201)
    expect(createKeys.claimItemCreateKey).not.toHaveBeenCalled()
  })
})

describe('POST / — input validation', () => {
  it('rejects a single oversized tag (>50 chars) with 400 and never calls addItem', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('tags', JSON.stringify(['A'.repeat(10000)]))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
    expect(itemsTools.addItem).not.toHaveBeenCalled()
  })

  it('rejects too many tags (array cap) with 400 and never calls addItem', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('tags', JSON.stringify(Array(200).fill('abcde')))
    expect(res.status).toBe(400)
    expect(itemsTools.addItem).not.toHaveBeenCalled()
  })

  it('accepts a normal 3-tag create (regression guard)', async () => {
    vi.mocked(itemsTools.addItem).mockResolvedValue({ item: mockItem } as any)
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('tags', JSON.stringify(['casual', 'summer', 'blue']))
    expect(res.status).toBe(201)
    expect(itemsTools.addItem).toHaveBeenCalledTimes(1)
  })

  it('returns 400 with field-level error for malformed JSON in colors', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('colors', 'not-valid-json')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
    expect(res.body.issues).toBeDefined()
    expect(res.body.issues[0].path).toContain('colors')
    expect(itemsTools.addItem).not.toHaveBeenCalled()
  })

  it('returns 400 with field-level error for malformed JSON in season', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .attach('image', Buffer.from('fake-image'), 'test.jpg')
      .field('season', '[invalid')
    expect(res.status).toBe(400)
    expect(res.body.issues[0].path).toContain('season')
  })
})

describe('PATCH /:id — input validation', () => {
  it('rejects oversized aiDescription with 400 and never calls updateItem', async () => {
    const app = makeApp()
    const res = await request(app).patch('/item1').send({ aiDescription: 'A'.repeat(2000) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
    expect(itemsTools.updateItem).not.toHaveBeenCalled()
  })
})

describe('PATCH /:id', () => {
  it('updates item', async () => {
    vi.mocked(itemsTools.updateItem).mockResolvedValue({ ...mockItem, brand: 'Nike' } as any)
    const app = makeApp()
    const res = await request(app).patch('/item1').send({ brand: 'Nike' })
    expect(res.status).toBe(200)
    expect(res.body.brand).toBe('Nike')
  })

  it('returns 404 when not found', async () => {
    vi.mocked(itemsTools.updateItem).mockRejectedValue(new Error('Item item99 not found'))
    const app = makeApp()
    const res = await request(app).patch('/item99').send({ brand: 'X' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:id', () => {
  it('deletes item', async () => {
    vi.mocked(itemsTools.deleteItem).mockResolvedValue(undefined)
    const app = makeApp()
    const res = await request(app).delete('/item1')
    expect(res.status).toBe(204)
  })
})

describe('POST /:id/worn', () => {
  it('marks item worn', async () => {
    vi.mocked(itemsTools.markWorn).mockResolvedValue({ ...mockItem, timesWorn: 1 } as any)
    const app = makeApp()
    const res = await request(app).post('/item1/worn')
    expect(res.status).toBe(200)
    expect(res.body.timesWorn).toBe(1)
  })

  it('returns 404 when not found', async () => {
    vi.mocked(itemsTools.markWorn).mockRejectedValue(new Error('Item item99 not found'))
    const app = makeApp()
    const res = await request(app).post('/item99/worn')
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/tag', () => {
  it('returns tag data from image', async () => {
    const mockTag = { brand: "Levi's", size: 'M', material_composition: '100% cotton', care_instructions: ['Machine wash'], country_of_origin: 'USA' }
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    vi.mocked(scanTagMod.scanTag).mockResolvedValue({ data: mockTag, usage: { tokensIn: 80, tokensOut: 30 } } as any)
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/tags/abc.jpg')
    vi.mocked(queries.updateItem).mockReturnValue({ ...mockItem, brand: "Levi's", tagImageUri: 'images/tags/abc.jpg' } as any)
    const app = makeApp()
    const res = await request(app)
      .post('/item1/tag')
      .attach('image', Buffer.from('fake-tag'), 'tag.jpg')
    expect(res.status).toBe(200)
    expect(res.body.tagData.brand).toBe("Levi's")
  })

  it('sets materialSource to ocr when material_composition is present', async () => {
    const mockTag = { brand: null, size: null, material_composition: '100% wool', care_instructions: [], country_of_origin: null }
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    vi.mocked(scanTagMod.scanTag).mockResolvedValue({ data: mockTag, usage: { tokensIn: 80, tokensOut: 30 } } as any)
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/tags/abc.jpg')
    vi.mocked(queries.updateItem).mockReturnValue({ ...mockItem, material: '100% wool', materialSource: 'ocr' } as any)
    const app = makeApp()
    await request(app)
      .post('/item1/tag')
      .attach('image', Buffer.from('fake-tag'), 'tag.jpg')
    expect(queries.updateItem).toHaveBeenCalledWith(
      'item1',
      undefined,
      expect.any(Object),
    )
    expect((queries.updateItem as ReturnType<typeof vi.fn>).mock.calls[0][2]).toHaveProperty('material', '100% wool')
  })

  function cleanupOcrRows() {
    db.delete(aiCalls).where(sql`user_id = 'self' AND task = 'ocr'`).run()
  }
  afterAll(cleanupOcrRows)
  beforeEach(cleanupOcrRows)

  it('returns 429 when monthly OCR limit is reached', async () => {
    // Pin rows inside the current calendar month so the route's
    // `createdAt >= monthStart` filter counts all 10 regardless of the
    // wall-clock day (the old `now - N hours` crossed into last month
    // on day 1 before 10am and made the test flaky).
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    for (let i = 0; i < 10; i++) {
      db.insert(aiCalls).values({
        id: `ocr-limit-${i}`,
        userId: 'self',
        task: 'ocr',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        success: 1,
        parseSuccess: 1,
        createdAt: monthStart + (i + 1) * 60_000, // 1..10 min after midnight, this month
      }).run()
    }

    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    const app = makeAppWithAuth()
    const res = await request(app)
      .post('/item1/tag')
      .attach('image', Buffer.from('fake-tag'), 'tag.jpg')
    expect(res.status).toBe(429)
    expect(res.body.error).toContain('Resets on')
  })

  it('allows scan when below monthly OCR limit', async () => {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    for (let i = 0; i < 9; i++) {
      db.insert(aiCalls).values({
        id: `ocr-under-${i}`,
        userId: 'self',
        task: 'ocr',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        success: 1,
        parseSuccess: 1,
        createdAt: monthStart + (i + 1) * 60_000, // 1..9 min after midnight, this month
      }).run()
    }

    const mockTag = { brand: "Levi's", size: 'M', material_composition: '100% cotton', care_instructions: [], country_of_origin: null }
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    vi.mocked(scanTagMod.scanTag).mockResolvedValue({ data: mockTag, usage: { tokensIn: 80, tokensOut: 30 } } as any)
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/tags/abc.jpg')
    vi.mocked(queries.updateItem).mockReturnValue({ ...mockItem, brand: "Levi's", tagImageUri: 'images/tags/abc.jpg' } as any)
    const app = makeAppWithAuth()
    const res = await request(app)
      .post('/item1/tag')
      .attach('image', Buffer.from('fake-tag'), 'tag.jpg')
    expect(res.status).toBe(200)
    expect(res.body.tagData.brand).toBe("Levi's")
  })
})

describe('PATCH /:id — materialSource', () => {
  it('sets materialSource to manual when material is in the request body', async () => {
    vi.mocked(itemsTools.updateItem).mockResolvedValue({ ...mockItem, material: 'silk', materialSource: 'manual' } as any)
    const app = makeApp()
    const res = await request(app).patch('/item1').send({ material: 'silk' })
    expect(res.status).toBe(200)
    expect(itemsTools.updateItem).toHaveBeenCalledWith(
      'item1',
      expect.any(Object),
      undefined,
    )
    expect((itemsTools.updateItem as ReturnType<typeof vi.fn>).mock.calls[0][1]).toHaveProperty('material', 'silk')
  })

  it('does not set materialSource when material is absent from body', async () => {
    vi.mocked(itemsTools.updateItem).mockResolvedValue({ ...mockItem, brand: 'Zara' } as any)
    const app = makeApp()
    await request(app).patch('/item1').send({ brand: 'Zara' })
    expect(itemsTools.updateItem).toHaveBeenCalledWith(
      'item1',
      expect.any(Object),
      undefined,
    )
    expect((itemsTools.updateItem as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toHaveProperty('materialSource')
  })
})

describe('POST /:id/images', () => {
  it('returns 400 when no image provided', async () => {
    const app = makeApp()
    const res = await request(app).post('/item1/images')
    expect(res.status).toBe(400)
  })

  it('returns 404 when item not found', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(null)
    const app = makeApp()
    const res = await request(app)
      .post('/item1/images')
      .attach('image', Buffer.from('fake'), 'test.jpg')
    expect(res.status).toBe(404)
  })

  it('creates image and updates item.imageUri when first image (isPrimary=1)', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    vi.mocked(queries.getItemImages).mockReturnValue([])
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/items/new.jpg')
    vi.mocked(queries.insertItemImage).mockReturnValue({
      id: 'img-1',
      itemId: 'item1',
      imageUri: 'images/items/new.jpg',
      role: 'reference',
      view: null,
      isPrimary: 1,
      position: 0,
    } as any)
    vi.mocked(queries.updateItem).mockReturnValue({ ...mockItem, imageUri: 'images/items/new.jpg' } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/item1/images')
      .attach('image', Buffer.from('fake'), 'test.jpg')

    expect(res.status).toBe(201)
    expect(res.body.isPrimary).toBe(1)
    expect(res.body.imageUri).toBe('images/items/new.jpg')
    expect(queries.setItemImagePrimary).toHaveBeenCalledWith('item1', 'img-1', undefined)
    expect(queries.updateItem).toHaveBeenCalledWith(
      'item1',
      undefined,
      expect.objectContaining({ imageUri: 'images/items/new.jpg' }),
    )
  })

  it('creates image with isPrimary=0 when item already has images and does not update item.imageUri', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(mockItem as any)
    vi.mocked(queries.getItemImages).mockReturnValue([
      { id: 'existing', itemId: 'item1', imageUri: 'images/items/old.jpg', role: 'crop', isPrimary: 1, position: 0 },
    ] as any)
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/items/new.jpg')
    vi.mocked(queries.insertItemImage).mockReturnValue({
      id: 'img-2',
      itemId: 'item1',
      imageUri: 'images/items/new.jpg',
      role: 'reference',
      view: null,
      isPrimary: 0,
      position: 1,
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/item1/images')
      .attach('image', Buffer.from('fake'), 'test.jpg')

    expect(res.status).toBe(201)
    expect(res.body.isPrimary).toBe(0)
    expect(queries.setItemImagePrimary).not.toHaveBeenCalled()
    expect(queries.updateItem).not.toHaveBeenCalledWith(
      'item1',
      undefined,
      expect.objectContaining({ imageUri: 'images/items/new.jpg' }),
    )
  })
})

describe('POST /bulk-detect', () => {
  it('returns cost with tokensIn > 0 and wholesaleCostCentsX100 > 0', async () => {
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/source/abc.jpg')
    const app = makeApp()
    const res = await request(app)
      .post('/bulk-detect')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')

    expect(res.status).toBe(200)
    expect(res.body.cost).toBeDefined()
    expect(res.body.cost.tokensIn).toBeGreaterThan(0)
    expect(res.body.cost.wholesaleCostCentsX100).toBeGreaterThan(0)
    expect(res.body.detections).toHaveLength(1)
    expect(imageStorage.deleteImage).not.toHaveBeenCalled()
  })

  // #342 — a failure after the source image is saved must not leave it behind.
  it('deletes the staged source image when detection fails', async () => {
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/source/fail.jpg')
    const { runInstrumentedDetailed } = await import('../../../../src/ai/instrumented.js')
    vi.mocked(runInstrumentedDetailed).mockRejectedValueOnce(new Error('provider 500'))
    const res = await request(makeAppWithAuth())
      .post('/bulk-detect')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')
    expect(res.status).toBe(500)
    expect(imageStorage.deleteImage).toHaveBeenCalledExactlyOnceWith('images/source/fail.jpg', 'self')
  })

  it('deletes the staged source image on insufficient tokens and still returns 402', async () => {
    // The 402 mapping is hosted-only (self-host has no paywall); the cleanup isn't.
    vi.stubEnv('HOSTED_MODE', 'true')
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/source/broke.jpg')
    const { runInstrumentedDetailed } = await import('../../../../src/ai/instrumented.js')
    const { InsufficientTokensError } = await import('../../../../src/cost/errors.js')
    vi.mocked(runInstrumentedDetailed).mockRejectedValueOnce(new InsufficientTokensError(2, 0))
    const res = await request(makeAppWithAuth())
      .post('/bulk-detect')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')
    expect(res.status).toBe(402)
    expect(imageStorage.deleteImage).toHaveBeenCalledExactlyOnceWith('images/source/broke.jpg', 'self')
  })

  it('keeps the original error when cleanup itself fails', async () => {
    // The 402 mapping is hosted-only (self-host has no paywall); the cleanup isn't.
    vi.stubEnv('HOSTED_MODE', 'true')
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.mocked(imageStorage.saveImageFromBase64).mockResolvedValue('images/source/stuck.jpg')
    vi.mocked(imageStorage.deleteImage).mockRejectedValueOnce(new Error('EACCES'))
    const { runInstrumentedDetailed } = await import('../../../../src/ai/instrumented.js')
    const { InsufficientTokensError } = await import('../../../../src/cost/errors.js')
    vi.mocked(runInstrumentedDetailed).mockRejectedValueOnce(new InsufficientTokensError(2, 0))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await request(makeAppWithAuth())
      .post('/bulk-detect')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')
    expect(res.status).toBe(402)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('failed to delete staged source image'), 'images/source/stuck.jpg', expect.any(Error))
    logged.mockRestore()
  })

  it('has nothing to clean up when the save itself fails', async () => {
    vi.mocked(imageStorage.saveImageFromBase64).mockRejectedValueOnce(new Error('disk full'))
    const res = await request(makeAppWithAuth())
      .post('/bulk-detect')
      .attach('image', Buffer.from('fake-image-data'), 'test.jpg')
    expect(res.status).toBe(500)
    expect(imageStorage.deleteImage).not.toHaveBeenCalled()
  })
})

// #346 / #347 — /bulk-save had no caller after BulkAdd.tsx was removed
// (AddItemFlow saves each item through POST /). It trusted client boxes and
// fanned out AI work unbounded, so it was deleted rather than hardened.
describe('POST /bulk-save (removed)', () => {
  it('is no longer routed', async () => {
    const res = await request(makeAppWithAuth()).post('/bulk-save').send({ sourceUri: 'images/source/x.jpg', detections: [] })
    expect(res.status).toBe(404)
  })
})
