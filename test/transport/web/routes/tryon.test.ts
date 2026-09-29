import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express, { Router } from 'express'
import { perUserRateLimit } from '../../../../src/transport/web/middleware/perUserRateLimit.js'

const mockGetTryonResults = vi.fn()
const mockUpdateTryonResult = vi.fn()
const mockGetOutfit = vi.fn()
const mockGetItem = vi.fn()
const mockGetItemImages = vi.fn().mockReturnValue([])
const mockGetUserPhotos = vi.fn().mockReturnValue([])
const mockInsertTryonResult = vi.fn()
const mockDeleteTryonResult = vi.fn()

vi.mock('../../../../src/db/queries.js', () => ({
  getTryonResults: (...args: unknown[]) => mockGetTryonResults(...args),
  updateTryonResult: (...args: unknown[]) => mockUpdateTryonResult(...args),
  getOutfit: (...args: unknown[]) => mockGetOutfit(...args),
  getItem: (...args: unknown[]) => mockGetItem(...args),
  getItemImages: (...args: unknown[]) => mockGetItemImages(...args),
  getUserPhotos: (...args: unknown[]) => mockGetUserPhotos(...args),
  insertTryonResult: (...args: unknown[]) => mockInsertTryonResult(...args),
  deleteTryonResult: (...args: unknown[]) => mockDeleteTryonResult(...args),
}))

const mockImageToBase64 = vi.fn()
const mockImageToBase64Compressed = vi.fn()
const mockImageToBase64SquarePadded = vi.fn()

vi.mock('../../../../src/storage/images.js', () => ({
  imageToBase64: (...args: unknown[]) => mockImageToBase64(...args),
  imageToBase64Compressed: (...args: unknown[]) => mockImageToBase64Compressed(...args),
  imageToBase64SquarePadded: (...args: unknown[]) => mockImageToBase64SquarePadded(...args),
  deleteImage: vi.fn(),
  saveImageFromBase64: vi.fn(),
}))

vi.mock('../../../../src/ai/tryon.js', () => ({
  generateTryOn: vi.fn(),
  generateWearSuggestions: vi.fn(),
}))

// Billing is exercised in test/billing/wallet.test.ts. These route tests
// verify wiring only, so bypass the wallet and just run the wrapped call.
vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn(async (input: any) => (await input.call({})).result),
  isMockImageGen: vi.fn(() => false),
}))

vi.mock('../../../../src/ai/client.js', () => ({
  isModelBusy: vi.fn().mockReturnValue(false),
  IMAGE_GEN_MODEL: 'gemini-2.5-flash-image-preview',
}))

let router: Router

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../../../../src/transport/web/routes/tryon.js')
  router = mod.default
})

function appWithAuth(userId = 'user1') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  app.use('/api/tryon', router)
  return app
}

const baseTryonResult = {
  id: 'tr1',
  userId: 'user1',
  userPhotoId: 'photo1',
  outfitId: null,
  itemIds: '["item1"]',
  resultImageUri: 'images/tryon/r1.jpg',
  promptInstruction: null,
  createdAt: 1,
}

describe('PATCH /api/tryon/:id', () => {
  it('sets outfitId when currently null', async () => {
    mockGetTryonResults.mockReturnValue([baseTryonResult])
    mockGetOutfit.mockReturnValue({ id: 'outfit1', userId: 'user1' })
    mockUpdateTryonResult.mockReturnValue({ ...baseTryonResult, outfitId: 'outfit1' })

    const app = appWithAuth()
    const res = await request(app)
      .patch('/api/tryon/tr1')
      .send({ outfitId: 'outfit1' })

    expect(res.status).toBe(200)
    expect(res.body.outfitId).toBe('outfit1')
    expect(mockUpdateTryonResult).toHaveBeenCalledWith('tr1', 'user1', { outfitId: 'outfit1' })
  })

  it('rejects linking an outfit the caller does not own', async () => {
    mockGetTryonResults.mockReturnValue([baseTryonResult])
    mockGetOutfit.mockReturnValue(undefined)
    mockUpdateTryonResult.mockClear()

    const res = await request(appWithAuth())
      .patch('/api/tryon/tr1')
      .send({ outfitId: 'someone-elses-outfit' })

    expect(res.status).toBe(404)
    expect(mockGetOutfit).toHaveBeenCalledWith('someone-elses-outfit', 'user1')
    expect(mockUpdateTryonResult).not.toHaveBeenCalled()
  })

  it('returns 400 when outfitId is missing', async () => {
    const app = appWithAuth()
    const res = await request(app)
      .patch('/api/tryon/tr1')
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('outfitId is required')
  })

  it('returns 404 when tryon result does not exist', async () => {
    mockGetTryonResults.mockReturnValue([])

    const app = appWithAuth()
    const res = await request(app)
      .patch('/api/tryon/tr1')
      .send({ outfitId: 'outfit1' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Tryon result not found')
  })

  it('returns 409 when outfitId is already set (idempotent)', async () => {
    const alreadyLinked = { ...baseTryonResult, outfitId: 'existing-outfit' }
    mockGetTryonResults.mockReturnValue([alreadyLinked])
    mockGetOutfit.mockReturnValue({ id: 'existing-outfit', name: 'My Outfit' })

    const app = appWithAuth()
    const res = await request(app)
      .patch('/api/tryon/tr1')
      .send({ outfitId: 'new-outfit' })

    expect(res.status).toBe(409)
    expect(res.body.outfitId).toBe('existing-outfit')
    expect(res.body.outfit).toEqual({ id: 'existing-outfit', name: 'My Outfit' })
    expect(mockUpdateTryonResult).not.toHaveBeenCalled()
  })

  it('scopes by userId — denies cross-user update', async () => {
    mockGetTryonResults.mockImplementation((userId: string) =>
      userId === 'user1' ? [baseTryonResult] : []
    )

    const app = appWithAuth('other-user')
    const res = await request(app)
      .patch('/api/tryon/tr1')
      .send({ outfitId: 'outfit1' })

    expect(res.status).toBe(404)
    expect(mockUpdateTryonResult).not.toHaveBeenCalled()
  })
})

// ─── POST /api/tryon (issue #152 — speed-up) ─────────────────────────────────

const mockItemBase = {
  id: 'item1',
  userId: 'user1',
  imageUri: 'images/items/fallback.jpg',
  category: 'tops',
  subcategory: 't-shirt',
  aiDescription: 'A cotton t-shirt',
  tags: JSON.stringify(['casual']),
  colors: JSON.stringify(['white']),
  season: JSON.stringify(['summer']),
  occasion: null,
  brand: null,
  size: null,
  material: null,
  careInstructions: null,
  tagImageUri: null,
  wearContext: null,
  createdAt: 1,
}

const mockUserPhoto = {
  id: 'photo1',
  userId: 'user1',
  imageUri: 'images/user/photo.jpg',
  createdAt: 1,
}

describe('POST /api/tryon — primary-view flag', () => {
  beforeEach(() => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('user-b64')
    mockImageToBase64Compressed.mockResolvedValue('item-b64')
    mockInsertTryonResult.mockReturnValue({ id: 'tr1' })
  })

  it('sends only the primary view per item when TRYON_PRIMARY_VIEW_ONLY is true (default)', async () => {
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'true'
    mockGetItem.mockReturnValue(mockItemBase)
    mockGetItemImages.mockReturnValue([
      { imageUri: 'images/items/primary.jpg', role: 'reference', isPrimary: 1 },
      { imageUri: 'images/items/back.jpg', role: 'reference', isPrimary: 0 },
    ])

    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const app = appWithAuth()
    const res = await request(app)
      .post('/api/tryon')
      .send({ userPhotoId: 'photo1', itemIds: ['item1'] })

    expect(res.status).toBe(201)
    // Try-on reads use the default size; the refine chips (#312) read the same
    // primary view small, with an explicit size.
    const tryonReads = mockImageToBase64Compressed.mock.calls.filter(c => c[2] === undefined)
    expect(tryonReads).toEqual([['images/items/primary.jpg', 'user1']])
    expect(mockImageToBase64Compressed).toHaveBeenCalledWith('images/items/primary.jpg', 'user1', { maxDim: 384, quality: 60 })
    const b64s = vi.mocked(generateTryOn).mock.calls[0][1] as string[]
    expect(b64s).toHaveLength(1)
  })

  it('falls back to item.imageUri when no primary row exists', async () => {
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'true'
    mockGetItem.mockReturnValue(mockItemBase)
    mockGetItemImages.mockReturnValue([
      { imageUri: 'images/items/front.jpg', role: 'reference', isPrimary: 0 },
    ])

    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const app = appWithAuth()
    const res = await request(app)
      .post('/api/tryon')
      .send({ userPhotoId: 'photo1', itemIds: ['item1'] })

    expect(res.status).toBe(201)
    expect(mockImageToBase64Compressed).toHaveBeenCalledWith('images/items/fallback.jpg', 'user1')
    expect(vi.mocked(generateTryOn).mock.calls[0][1]).toHaveLength(1)
  })

  it('sends all non-source views when TRYON_PRIMARY_VIEW_ONLY is false', async () => {
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'false'
    mockGetItem.mockReturnValue(mockItemBase)
    mockGetItemImages.mockReturnValue([
      { imageUri: 'images/items/front.jpg', role: 'reference', isPrimary: 1 },
      { imageUri: 'images/items/back.jpg', role: 'reference', isPrimary: 0 },
    ])

    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const app = appWithAuth()
    const res = await request(app)
      .post('/api/tryon')
      .send({ userPhotoId: 'photo1', itemIds: ['item1'] })

    expect(res.status).toBe(201)
    expect(mockImageToBase64Compressed.mock.calls.filter(c => c[2] === undefined)).toHaveLength(2)
    expect(vi.mocked(generateTryOn).mock.calls[0][1]).toHaveLength(2)
  })
})

describe('POST /api/tryon — ordering', () => {
  beforeEach(() => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('user-b64')
    mockImageToBase64Compressed.mockImplementation((uri: string) =>
      Promise.resolve(`b64:${uri}`),
    )
    mockInsertTryonResult.mockReturnValue({ id: 'tr1' })
  })

  it('preserves itemIds order in image base64s and appends garmentUris', async () => {
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'true'
    const item1 = { ...mockItemBase, id: 'itemA', imageUri: 'images/items/a.jpg' }
    const item2 = { ...mockItemBase, id: 'itemB', imageUri: 'images/items/b.jpg' }
    const item3 = { ...mockItemBase, id: 'itemC', imageUri: 'images/items/c.jpg' }
    mockGetItem.mockImplementation((id: string) => {
      if (id === 'itemA') return item1
      if (id === 'itemB') return item2
      if (id === 'itemC') return item3
      return null
    })
    mockGetItemImages.mockReturnValue([])

    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const app = appWithAuth()
    const res = await request(app)
      .post('/api/tryon')
      .send({
        userPhotoId: 'photo1',
        itemIds: ['itemA', 'itemB', 'itemC'],
        garmentUris: ['images/garments/g1.jpg', 'images/garments/g2.jpg'],
      })

    expect(res.status).toBe(201)
    const b64s = vi.mocked(generateTryOn).mock.calls[0][1] as string[]
    expect(b64s).toEqual([
      'b64:images/items/a.jpg',
      'b64:images/items/b.jpg',
      'b64:images/items/c.jpg',
      'b64:images/garments/g1.jpg',
      'b64:images/garments/g2.jpg',
    ])
  })
})

describe('POST /api/tryon — validation', () => {
  it('returns 404 when an item does not exist', async () => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('user-b64')
    mockGetItem.mockReturnValue(null)

    const app = appWithAuth()
    const res = await request(app)
      .post('/api/tryon')
      .send({ userPhotoId: 'photo1', itemIds: ['missing-item'] })

    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/Item missing-item not found/)
  })
})

describe('POST /api/tryon — square-padded user photo', () => {
  it('calls imageToBase64SquarePadded (not raw imageToBase64) for the user photo', async () => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('padded-b64')
    mockImageToBase64Compressed.mockResolvedValue('item-b64')
    mockGetItem.mockReturnValue(mockItemBase)
    mockGetItemImages.mockReturnValue([])
    mockInsertTryonResult.mockReturnValue({ id: 'tr1' })

    const app = appWithAuth()
    await request(app)
      .post('/api/tryon')
      .send({ userPhotoId: 'photo1', itemIds: ['item1'] })

    expect(mockImageToBase64SquarePadded).toHaveBeenCalledWith(mockUserPhoto.imageUri, 'user1')
    expect(mockImageToBase64).not.toHaveBeenCalled()
  })
})

describe('Rate limiters on tryon routes', () => {
  it('tryonLimiter returns 429 after 6 requests in 60s', async () => {
    vi.stubEnv('VITEST', '')
    const limiter = perUserRateLimit(60_000, 6)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.userId = 'rate-test-user'
      next()
    })
    app.use('/api/tryon', limiter, (req, res) => res.status(200).json({ ok: true }))

    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/tryon')
      expect(res.status).toBe(200)
    }
    const res = await request(app).post('/api/tryon')
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate_limited')

    vi.unstubAllEnvs()
  })

  it('garmentUploadLimiter returns 429 after 10 requests in 60s', async () => {
    vi.stubEnv('VITEST', '')
    const limiter = perUserRateLimit(60_000, 10)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.userId = 'garment-test-user'
      next()
    })
    app.use('/api/tryon/garments', limiter, (req, res) => res.status(201).json({ ok: true }))

    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/tryon/garments')
      expect(res.status).toBe(201)
    }
    const res = await request(app).post('/api/tryon/garments')
    expect(res.status).toBe(429)

    vi.unstubAllEnvs()
  })
})

describe('POST /api/tryon — local image model reference limit (#352)', () => {
  beforeEach(() => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('user-b64')
    mockImageToBase64Compressed.mockImplementation((uri: string) => Promise.resolve(`b64:${uri}`))
    mockInsertTryonResult.mockReturnValue({ id: 'tr1' })
    process.env.IMAGE_GEN_MODEL = 'local/Qwen/Qwen-Image-2.1'
  })
  afterEach(() => {
    delete process.env.IMAGE_GEN_MODEL
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'true'
  })

  const items = (ids: string[]) => mockGetItem.mockImplementation((id: string) =>
    ids.includes(id) ? { ...mockItemBase, id, imageUri: `images/items/${id}.jpg` } : null)

  it('refuses 4 garments (person + 4 > 4 references) before any call is made', async () => {
    items(['a', 'b', 'c', 'd'])
    mockGetItemImages.mockReturnValue([])
    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['a', 'b', 'c', 'd'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at most 3 garments/)
    expect(generateTryOn).not.toHaveBeenCalled()
  })

  it('in all-views mode, keeps every garment and drops extra views, reporting how many', async () => {
    process.env.TRYON_PRIMARY_VIEW_ONLY = 'false'
    items(['a', 'b'])
    mockGetItemImages.mockImplementation((id: string) => [
      { imageUri: `images/items/${id}-back.jpg`, role: 'reference', isPrimary: 0 },
      { imageUri: `images/items/${id}-front.jpg`, role: 'reference', isPrimary: 1 },
      { imageUri: `images/items/${id}-side.jpg`, role: 'reference', isPrimary: 0 },
    ])
    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['a', 'b'] })
    expect(res.status).toBe(201)
    expect(res.body.droppedViews).toBe(3)
    expect(vi.mocked(generateTryOn).mock.calls[0][1]).toEqual([
      'b64:images/items/a-front.jpg', 'b64:images/items/a-back.jpg', 'b64:images/items/b-front.jpg',
    ])
  })

  it('answers a per-user busy error with 429', async () => {
    items(['a'])
    mockGetItemImages.mockReturnValue([])
    const { generateTryOn } = await import('../../../../src/ai/tryon.js')
    const { ImageGenUserBusyError } = await import('../../../../src/ai/localImage.js')
    vi.mocked(generateTryOn).mockRejectedValueOnce(new ImageGenUserBusyError())
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['a'] })
    expect(res.status).toBe(429)
    expect(res.body.error).toMatch(/already have an image generating/)
  })
})

describe('refine chips (#312)', () => {
  beforeEach(() => {
    mockGetUserPhotos.mockReturnValue([mockUserPhoto])
    mockImageToBase64SquarePadded.mockResolvedValue('user-b64')
    mockImageToBase64Compressed.mockImplementation((uri: string, _u: string, opts?: unknown) =>
      Promise.resolve(opts ? `chip:${uri}` : `b64:${uri}`))
    mockInsertTryonResult.mockReturnValue({ id: 'tr1' })
    mockGetItem.mockImplementation((id: string) => (id === 'item1' ? mockItemBase : undefined))
    mockGetItemImages.mockReturnValue([{ imageUri: 'images/items/primary.jpg', role: 'reference', isPrimary: 1 }])
    delete process.env.TEXT_MODEL
  })
  afterEach(() => { delete process.env.TEXT_MODEL })

  it('returns chips scoped to a tried-on item, with its id and label', async () => {
    const { generateWearSuggestions } = await import('../../../../src/ai/tryon.js')
    vi.mocked(generateWearSuggestions).mockResolvedValue({
      data: [{ label: 'Tucked', instruction: 'Tuck the t-shirt in.', itemIndex: 0 }],
      usage: { tokensIn: 1, tokensOut: 1 },
    })
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['item1'] })
    expect(res.status).toBe(201)
    expect(res.body.wearSuggestions).toEqual([
      { label: 'Tucked', instruction: 'Tuck the t-shirt in.', itemId: 'item1', itemLabel: 't-shirt' },
    ])
    // The primary view goes to the chip model, small.
    const [garments] = vi.mocked(generateWearSuggestions).mock.calls[0]
    expect(garments).toEqual([expect.objectContaining({ imageBase64: 'chip:images/items/primary.jpg' })])
  })

  it('passes the source outfit as chip context without linking the history row to it', async () => {
    const { generateWearSuggestions } = await import('../../../../src/ai/tryon.js')
    vi.mocked(generateWearSuggestions).mockResolvedValue({ data: [], usage: { tokensIn: 0, tokensOut: 0 } })
    mockGetOutfit.mockReturnValue({ id: 'o1', name: 'Beach day', occasion: 'casual', season: '["summer"]' })
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['item1'], sourceOutfitId: 'o1' })
    expect(res.status).toBe(201)
    expect(mockGetOutfit).toHaveBeenCalledWith('o1', 'user1')
    expect(vi.mocked(generateWearSuggestions).mock.calls[0][1]).toEqual({
      outfit: { name: 'Beach day', occasion: 'casual', season: ['summer'] },
    })
    expect(mockInsertTryonResult.mock.calls[0][1]).not.toHaveProperty('outfitId')
  })

  it('a chip failure never fails the paid try-on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { generateWearSuggestions } = await import('../../../../src/ai/tryon.js')
    vi.mocked(generateWearSuggestions).mockRejectedValue(new Error('chip model down'))
    const res = await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['item1'] })
    expect(res.status).toBe(201)
    expect(res.body.wearSuggestions).toEqual([])
    expect(mockInsertTryonResult).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('sends text only to a local text model', async () => {
    process.env.TEXT_MODEL = 'local/qwen3-8b'
    const { generateWearSuggestions } = await import('../../../../src/ai/tryon.js')
    vi.mocked(generateWearSuggestions).mockResolvedValue({ data: [], usage: { tokensIn: 0, tokensOut: 0 } })
    await request(appWithAuth()).post('/api/tryon').send({ userPhotoId: 'photo1', itemIds: ['item1'] })
    const [garments] = vi.mocked(generateWearSuggestions).mock.calls[0]
    expect(garments[0]).not.toHaveProperty('imageBase64')
    expect(mockImageToBase64Compressed.mock.calls.some(c => c[2] !== undefined)).toBe(false)
  })

  it('POST /suggestions scopes chips to the caller\'s items and skips unknown ones', async () => {
    const { generateWearSuggestions } = await import('../../../../src/ai/tryon.js')
    vi.mocked(generateWearSuggestions).mockResolvedValue({
      data: [{ label: 'Rolled', instruction: 'Roll the t-shirt sleeves.', itemIndex: 0 }],
      usage: { tokensIn: 1, tokensOut: 1 },
    })
    const res = await request(appWithAuth()).post('/api/tryon/suggestions').send({ itemIds: ['someone-elses', 'item1'] })
    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual([
      { label: 'Rolled', instruction: 'Roll the t-shirt sleeves.', itemId: 'item1', itemLabel: 't-shirt' },
    ])
    expect(vi.mocked(generateWearSuggestions).mock.calls[0][0]).toHaveLength(1)
  })
})
