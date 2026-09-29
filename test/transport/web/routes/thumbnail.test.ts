import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../../../src/tools/items.js', () => ({
  addItem: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  markWorn: vi.fn(),
  countItems: vi.fn(),
  listItemCards: vi.fn(),
}))

vi.mock('../../../../src/ai/categorize.js', () => ({ categorizeItem: vi.fn() }))
vi.mock('../../../../src/ai/scanTag.js', () => ({ scanTag: vi.fn() }))
vi.mock('../../../../src/ai/detectItems.js', () => ({ detectItems: vi.fn() }))
vi.mock('../../../../src/ai/heroImage.js', () => ({ generateHeroImage: vi.fn() }))
// Billing is exercised in test/billing/wallet.test.ts. These route tests
// verify wiring only, so bypass the wallet and just run the wrapped call.
vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn(async (input: any) => (await input.call({})).result),
  isMockImageGen: vi.fn(() => false),
}))
vi.mock('../../../../src/storage/images.js', () => ({
  saveImageFromBase64: vi.fn(),
  imageToBase64: vi.fn(),
  resolveImagePath: vi.fn(),
  deleteImage: vi.fn(),
}))
vi.mock('../../../../src/db/queries.js', () => ({
  updateItem: vi.fn(),
  insertItem: vi.fn(),
  getUniqueTags: vi.fn(),
  getUniqueSubcategories: vi.fn(),
  getUniqueCategories: vi.fn(),
  getItemImages: vi.fn(),
  insertItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
  getItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
}))
vi.mock('../../../../src/ai/embedImage.js', () => ({
  embedItemOnSave: vi.fn(),
  deleteEmbeddingsForItem: vi.fn(),
}))
vi.mock('../../../../src/ai/embed.js', () => ({
  embedItemTextOnSave: vi.fn(),
  deleteTextEmbeddingsForItem: vi.fn(),
}))

import * as itemsTools from '../../../../src/tools/items.js'
import * as queries from '../../../../src/db/queries.js'
import * as storage from '../../../../src/storage/images.js'
import * as heroImage from '../../../../src/ai/heroImage.js'
import itemsRouter from '../../../../src/transport/web/routes/items.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', itemsRouter)
  return app
}

describe('POST /:id/thumbnail', () => {
  const app = makeApp()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 404 when item does not exist', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue(null as any)
    const res = await request(app).post('/test-id/thumbnail').send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Item not found')
  })

  it('returns 400 when no reference images are available and no item.imageUri', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      imageUri: '',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    vi.mocked(queries.getItemImages).mockReturnValue([])
    vi.mocked(storage.imageToBase64).mockResolvedValue('' as any)

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('No reference images available')
  })

  it('backfills cover when no item_images rows but item.imageUri exists', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      imageUri: 'images/items/cover.jpg',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    vi.mocked(queries.getItemImages).mockReturnValue([])
    vi.mocked(queries.insertItemImage).mockReturnValue({
      id: 'backfilled-1',
      itemId: 'item-1',
      imageUri: 'images/items/cover.jpg',
      role: 'reference',
      isPrimary: 1,
      position: 0,
    } as any)
    vi.mocked(storage.imageToBase64).mockResolvedValue('base64data')
    vi.mocked(heroImage.generateHeroImage).mockResolvedValue('images/items/gen.jpg')

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(201)
    expect(queries.insertItemImage).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'item-1',
      imageUri: 'images/items/cover.jpg',
      role: 'reference',
    }))
  })

  it('returns 201 on successful generation', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    vi.mocked(queries.getItemImages).mockReturnValue([
      { id: 'img-1', imageUri: 'images/items/ref.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any)
    vi.mocked(storage.imageToBase64).mockResolvedValue('base64data')
    vi.mocked(heroImage.generateHeroImage).mockResolvedValue('images/items/gen.jpg')
    vi.mocked(queries.insertItemImage).mockReturnValue({
      id: 'gen-1',
      imageUri: 'images/items/gen.jpg',
      role: 'generated',
      isPrimary: 0,
      position: 1,
    } as any)

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(201)
    expect(res.body.imageUri).toBe('images/items/gen.jpg')
  })

  it('returns 400 when source count exceeds MAX_REF_IMAGES (8)', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    const nineSources = Array.from({ length: 9 }, (_, i) => ({
      id: `img-${i}`,
      imageUri: `images/items/ref${i}.jpg`,
      role: 'reference',
      isPrimary: i === 0 ? 1 : 0,
      position: i,
    })) as any
    vi.mocked(queries.getItemImages).mockReturnValue(nineSources)
    vi.mocked(storage.imageToBase64).mockResolvedValue('base64data')

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Maximum 8 reference images')
    expect(res.body.error).toContain('You selected 9')
    expect(heroImage.generateHeroImage).not.toHaveBeenCalled()
  })

  it('allows exactly 8 sources', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    const eightSources = Array.from({ length: 8 }, (_, i) => ({
      id: `img-${i}`,
      imageUri: `images/items/ref${i}.jpg`,
      role: 'reference',
      isPrimary: i === 0 ? 1 : 0,
      position: i,
    })) as any
    vi.mocked(queries.getItemImages).mockReturnValue(eightSources)
    vi.mocked(storage.imageToBase64).mockResolvedValue('short')
    vi.mocked(heroImage.generateHeroImage).mockResolvedValue('images/items/gen.jpg')
    vi.mocked(queries.insertItemImage).mockReturnValue({
      id: 'gen-1',
      imageUri: 'images/items/gen.jpg',
      role: 'generated',
    } as any)

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(201)
    expect(heroImage.generateHeroImage).toHaveBeenCalledWith(
      expect.arrayContaining(['short', 'short', 'short', 'short', 'short', 'short', 'short', 'short']),
      undefined,
      expect.any(String),
    )
  })

  it('returns 400 when total base64 size exceeds 10MB', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    vi.mocked(queries.getItemImages).mockReturnValue([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
      { id: 'img-2', imageUri: 'images/items/b.jpg', role: 'reference', isPrimary: 0, position: 1 },
      { id: 'img-3', imageUri: 'images/items/c.jpg', role: 'reference', isPrimary: 0, position: 2 },
    ] as any)
    // Mock 3 base64s of ~5MB decoded bytes each (base64 is ~1.33x decoded size)
    const bigBase64 = 'x'.repeat(7 * 1024 * 1024) // ~5.25MB decoded
    vi.mocked(storage.imageToBase64).mockResolvedValue(bigBase64)

    const res = await request(app).post('/item-1/thumbnail').send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('exceeds 10MB')
    expect(heroImage.generateHeroImage).not.toHaveBeenCalled()
  })

  it('returns 500 and logs error detail on generation failure', async () => {
    vi.mocked(itemsTools.getItem).mockResolvedValue({
      id: 'item-1',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      material: 'cotton',
      brand: null,
    } as any)
    vi.mocked(queries.getItemImages).mockReturnValue([
      { id: 'img-1', imageUri: 'images/items/ref.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any)
    vi.mocked(storage.imageToBase64).mockResolvedValue('base64data')
    vi.mocked(heroImage.generateHeroImage).mockRejectedValue(new Error('Gemini 403'))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await request(app).post('/item-1/thumbnail').send({ instruction: 'front view' })

    expect(res.status).toBe(500)
    expect(consoleSpy).toHaveBeenCalled()
    const logArg = consoleSpy.mock.calls[0]?.[1]
    expect(logArg).toHaveProperty('message', 'Gemini 403')
    expect(logArg).toHaveProperty('hasInstruction', true)
    consoleSpy.mockRestore()
  })
})
