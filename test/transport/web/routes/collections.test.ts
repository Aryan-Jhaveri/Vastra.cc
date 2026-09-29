import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../../../src/tools/collections.js', () => ({
  createCollection: vi.fn(),
  listCollections: vi.fn(),
  getCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  addOutfitsToCollection: vi.fn(),
  removeOutfitFromCollection: vi.fn(),
  reorderOutfitsInCollection: vi.fn(),
  getCollectionIdsForOutfit: vi.fn(),
}))

vi.mock('../../../../src/tools/items.js', () => ({
  listItems: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../../../src/db/queries.js', () => ({
  getAllOutfits: vi.fn().mockReturnValue([]),
  updateCollection: vi.fn(),
  getCollection: vi.fn(),
  getOutfitIdsInCollection: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../../src/storage/images.js', () => ({
  saveImageSquareCrop: vi.fn(),
  deleteImage: vi.fn(),
}))

import * as collectionsTools from '../../../../src/tools/collections.js'
import * as dbQueries from '../../../../src/db/queries.js'
import collectionsRouter from '../../../../src/transport/web/routes/collections.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', collectionsRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

const mockCol = {
  id: 'col1',
  name: 'Capsule',
  description: null,
  season: '[]',
  tags: '[]',
  coverImageUri: null,
}

describe('GET /', () => {
  it('lists collections with counts', async () => {
    vi.mocked(collectionsTools.listCollections).mockResolvedValue([mockCol] as any)
    const app = makeApp()
    const res = await request(app).get('/')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].outfitCount).toBe(0)
  })
})

describe('GET /?hydrate=true — outfitCount (#361)', () => {
  function appAs(userId: string) {
    const app = express()
    app.use((req, _res, next) => { (req as any).userId = userId; next() })
    app.use('/', collectionsRouter)
    return app
  }

  it('includes outfitCount matching the hydrated outfits, scoped to the caller', async () => {
    vi.mocked(collectionsTools.listCollections).mockResolvedValue([mockCol] as any)
    vi.mocked(dbQueries.getAllOutfits).mockReturnValue([
      { id: 'o1', itemIds: '[]' },
      { id: 'o2', itemIds: '[]' },
    ] as any)
    vi.mocked(dbQueries.getOutfitIdsInCollection).mockReturnValue(['o1', 'o2'])

    const res = await request(appAs('user-a')).get('/?hydrate=true')
    expect(res.status).toBe(200)
    expect(res.body[0].outfits).toHaveLength(2)
    expect(res.body[0].outfitCount).toBe(2)

    expect(collectionsTools.listCollections).toHaveBeenCalledWith('user-a')
    expect(dbQueries.getAllOutfits).toHaveBeenCalledWith('user-a')
    expect(dbQueries.getOutfitIdsInCollection).toHaveBeenCalledWith('col1', 'user-a')
  })

  it('does not count outfit ids the caller does not own', async () => {
    vi.mocked(collectionsTools.listCollections).mockResolvedValue([mockCol] as any)
    // Caller owns only o1; a stray foreign id must not inflate the count
    vi.mocked(dbQueries.getAllOutfits).mockReturnValue([{ id: 'o1', itemIds: '[]' }] as any)
    vi.mocked(dbQueries.getOutfitIdsInCollection).mockReturnValue(['o1', 'foreign'])

    const res = await request(appAs('user-a')).get('/?hydrate=true')
    expect(res.body[0].outfitCount).toBe(1)
  })

  it('single hydrated collection also carries outfitCount', async () => {
    vi.mocked(collectionsTools.getCollection).mockResolvedValue(mockCol as any)
    vi.mocked(dbQueries.getAllOutfits).mockReturnValue([{ id: 'o1', itemIds: '[]' }] as any)
    vi.mocked(dbQueries.getOutfitIdsInCollection).mockReturnValue(['o1'])

    const res = await request(appAs('user-a')).get('/col1?hydrate=true')
    expect(res.status).toBe(200)
    expect(res.body.outfitCount).toBe(1)
    expect(collectionsTools.getCollection).toHaveBeenCalledWith('col1', 'user-a')
  })
})

describe('POST /', () => {
  it('creates a collection (regression guard)', async () => {
    vi.mocked(collectionsTools.createCollection).mockResolvedValue(mockCol as any)
    const app = makeApp()
    const res = await request(app).post('/').send({ name: 'Capsule' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('col1')
    expect(collectionsTools.createCollection).toHaveBeenCalledTimes(1)
  })
})

describe('POST / — input validation', () => {
  it('rejects oversized description with 400 and never calls createCollection', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ name: 'Capsule', description: 'A'.repeat(2000) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
    expect(collectionsTools.createCollection).not.toHaveBeenCalled()
  })

  it('rejects an empty name with 400 and never calls createCollection', async () => {
    const app = makeApp()
    const res = await request(app).post('/').send({ name: '   ' })
    expect(res.status).toBe(400)
    expect(collectionsTools.createCollection).not.toHaveBeenCalled()
  })
})

describe('PATCH /:id — input validation', () => {
  it('rejects oversized name with 400 and never calls updateCollection', async () => {
    const app = makeApp()
    const res = await request(app).patch('/col1').send({ name: 'A'.repeat(200) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid input')
    expect(collectionsTools.updateCollection).not.toHaveBeenCalled()
  })
})
