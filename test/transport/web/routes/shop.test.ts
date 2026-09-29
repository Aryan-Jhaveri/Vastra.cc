import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

// Hoisted mock for the catalog client — configured per-test via vi.mocked()
vi.mock('../../../../src/commerce/shopify/catalog.js', () => ({
  searchGlobalCatalog: vi.fn(),
  lookupGlobalCatalog: vi.fn(),
  LOOKUP_MAX_IDS: 50,
}))

import { searchGlobalCatalog, lookupGlobalCatalog, type ShopProduct } from '../../../../src/commerce/shopify/catalog.js'
import { db } from '../../../../src/db/client.js'
import { likedProducts, users, items, settings } from '../../../../src/db/schema.js'
import { setSetting } from '../../../../src/db/queries.js'
import { eq, and } from 'drizzle-orm'
import shopRouter from '../../../../src/transport/web/routes/shop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const gid = (s: string) => `gid://shopify/p/${s}`

function product(id: string, over: Partial<ShopProduct> = {}): ShopProduct {
  return {
    id, title: `Title ${id}`, imageUrl: 'https://cdn.shopify.com/a.jpg', price: '10.00 CAD',
    merchant: 'M', url: 'https://shop.example/p', available: true, ...over,
  }
}

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../../../src/db/migrations') })
  for (const id of ['self', 'user_other']) {
    const existing = db.select().from(users).where(eq(users.id, id)).get()
    if (!existing) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

function makeApp(userId = 'self') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    req.authVia = 'cookie'
    next()
  })
  app.use('/', shopRouter)
  return app
}

function insertLike(userId: string, productId: string, createdAt = Date.now(), savedItemId: string | null = null) {
  db.insert(likedProducts).values({ id: `l_${userId}_${productId}`, userId, productId, savedItemId, createdAt }).run()
}

beforeEach(() => {
  vi.clearAllMocks()
  db.delete(likedProducts).run()
  db.delete(items).run()
  db.delete(settings).where(eq(settings.key, 'serverLocation')).run()
  db.delete(settings).where(eq(settings.key, 'shopGender')).run()
  db.delete(settings).where(eq(settings.key, 'userSizes')).run()
})

// ─── Schema ───────────────────────────────────────────────────────────────────

describe('liked_products schema (migration 0034)', () => {
  it('stores only ids — no cached catalog fields', () => {
    const cols = (db.$client.prepare('PRAGMA table_info(liked_products)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols.sort()).toEqual(['created_at', 'id', 'product_id', 'saved_item_id', 'user_id'])
  })
})

// ─── POST /api/shop/related ───────────────────────────────────────────────────

describe('POST /api/shop/related', () => {
  it('never sends the user\'s sizes to the catalog (#329)', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [product(gid('p1'))], nextCursor: null })
    setSetting('userSizes', JSON.stringify({ tops: 'ZZSIZE-TOPS', shoes: 'ZZSIZE-SHOES' }), 'self')
    setSetting('shopGender', 'male', 'self')
    const res = await request(makeApp()).post('/related').send({ query: 'light jacket', intent: 'Outfit for 12°C' })
    expect(res.status).toBe(200)
    expect(searchGlobalCatalog).toHaveBeenCalled()
    const outbound = JSON.stringify(vi.mocked(searchGlobalCatalog).mock.calls)
    expect(outbound).not.toContain('ZZSIZE')
    expect(outbound).not.toContain('userSizes')
    expect(JSON.stringify(res.body)).not.toContain('ZZSIZE')
  })

  it('returns products on success', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [product(gid('p1'))], nextCursor: null })

    const res = await request(makeApp()).post('/related').send({ query: 'light jacket' })
    expect(res.status).toBe(200)
    expect(res.body.products).toHaveLength(1)
    expect(res.body.error).toBeUndefined()
  })

  it('forwards query and intent to the catalog', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [], nextCursor: null })
    await request(makeApp()).post('/related').send({ query: ' light jacket ', intent: ' Outfit for 12°C ', cursor: 'c1' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0]).toEqual({
      query: 'light jacket', intent: 'Outfit for 12°C', country: undefined, gender: undefined, limit: 10, cursor: 'c1',
    })
  })

  it('passes the saved "Shop for" gender; Everyone sends none', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [], nextCursor: null })
    setSetting('shopGender', 'female', 'self')
    await request(makeApp()).post('/related').send({ query: 'q' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0].gender).toBe('female')

    setSetting('shopGender', 'any', 'self')
    await request(makeApp()).post('/related').send({ query: 'q' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[1][0].gender).toBeUndefined()

    // Another user's setting never applies.
    await request(makeApp('user_other')).post('/related').send({ query: 'q' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[2][0].gender).toBeUndefined()
  })

  it('returns empty array on catalog error (never 500)', async () => {
    vi.mocked(searchGlobalCatalog).mockRejectedValue(new Error('catalog timeout'))

    const res = await request(makeApp()).post('/related').send({ query: 'error test query' })
    expect(res.status).toBe(200)
    expect(res.body.products).toEqual([])
    expect(res.body.error).toBe('catalog_unavailable')
  })

  it('requires a query', async () => {
    const res = await request(makeApp()).post('/related').send({})
    expect(res.status).toBe(400)
  })

  it('never caches results — Shopify policy (every request is a live call)', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [], nextCursor: null })

    await request(makeApp()).post('/related').send({ query: 'same query' })
    await request(makeApp()).post('/related').send({ query: 'same query' })
    await request(makeApp('user_other')).post('/related').send({ query: 'same query' })

    expect(searchGlobalCatalog).toHaveBeenCalledTimes(3)
  })

  it('sends the saved location\'s ISO country code, not a guess from coordinates', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [], nextCursor: null })
    // Toronto — the old bounding boxes mapped this to US.
    setSetting('serverLocation', JSON.stringify({ enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' }), 'self')

    await request(makeApp()).post('/related').send({ query: 'country code query' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0].country).toBe('CA')
  })

  it('sends no country when the saved location has no country code', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [], nextCursor: null })
    setSetting('serverLocation', JSON.stringify({ enabled: true, lat: 43.65, lon: -79.38, name: 'Current location' }), 'self')

    await request(makeApp()).post('/related').send({ query: 'no country query' })
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0].country).toBeUndefined()
  })

  it('rejects a non-string cursor or intent', async () => {
    const badCursor = await request(makeApp()).post('/related').send({ query: 'q', cursor: { evil: true } })
    const badIntent = await request(makeApp()).post('/related').send({ query: 'q', intent: 42 })
    expect(badCursor.status).toBe(400)
    expect(badIntent.status).toBe(400)
    expect(searchGlobalCatalog).not.toHaveBeenCalled()
  })
})

// ─── Likes ────────────────────────────────────────────────────────────────────

describe('PUT /likes/:productId', () => {
  it('stores only the product id', async () => {
    const res = await request(makeApp()).put(`/likes/${encodeURIComponent(gid('p1'))}`)
      .send({ title: 'ignored', price: '1.00', imageUrl: 'https://cdn.shopify.com/x.jpg' })
    expect(res.status).toBe(200)

    const rows = db.select().from(likedProducts).where(eq(likedProducts.userId, 'self')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ productId: gid('p1'), savedItemId: null })
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'productId', 'savedItemId', 'userId'])
  })

  it('is idempotent and keeps the original like time', async () => {
    insertLike('self', gid('p1'), 1000)
    await request(makeApp()).put(`/likes/${encodeURIComponent(gid('p1'))}`)
    const rows = db.select().from(likedProducts).where(eq(likedProducts.userId, 'self')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].createdAt).toBe(1000)
  })

  it('rejects ids that are not Shopify product GIDs', async () => {
    for (const bad of ['p1', 'gid://shopify/p/', 'gid://shopify/Shop/1', `gid://shopify/p/${'x'.repeat(250)}`]) {
      const res = await request(makeApp()).put(`/likes/${encodeURIComponent(bad)}`)
      expect(res.status).toBe(400)
    }
    expect(db.select().from(likedProducts).all()).toHaveLength(0)
  })

  it('caps likes per user but still allows re-liking an existing product', async () => {
    const now = Date.now()
    db.insert(likedProducts).values(Array.from({ length: 500 }, (_, i) => ({
      id: `cap_${i}`, userId: 'self', productId: gid(`cap${i}`), createdAt: now,
    }))).run()

    const fresh = await request(makeApp()).put(`/likes/${encodeURIComponent(gid('new'))}`)
    expect(fresh.status).toBe(409)
    const again = await request(makeApp()).put(`/likes/${encodeURIComponent(gid('cap0'))}`)
    expect(again.status).toBe(200)
    const other = await request(makeApp('user_other')).put(`/likes/${encodeURIComponent(gid('new'))}`)
    expect(other.status).toBe(200)
  })
})

describe('GET /likes — live hydration', () => {
  it('hydrates each like with live catalog data, newest first, in one lookup', async () => {
    insertLike('self', gid('old'), 1000)
    insertLike('self', gid('new'), 2000)
    vi.mocked(lookupGlobalCatalog).mockResolvedValue({
      products: [product(gid('old')), product(gid('new'), { price: '99.00 CAD' })],
      notFound: [],
    })

    const res = await request(makeApp()).get('/likes')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    expect(res.body.nextOffset).toBeNull()
    expect(res.body.likes.map((l: { productId: string }) => l.productId)).toEqual([gid('new'), gid('old')])
    expect(res.body.likes[0]).toMatchObject({ status: 'live', product: { price: '99.00 CAD' } })

    expect(lookupGlobalCatalog).toHaveBeenCalledOnce()
    expect(vi.mocked(lookupGlobalCatalog).mock.calls[0][0].ids).toEqual([gid('new'), gid('old')])
  })

  it('marks delisted products gone and a failed lookup unknown', async () => {
    insertLike('self', gid('gone'), 1000)
    vi.mocked(lookupGlobalCatalog).mockResolvedValueOnce({ products: [], notFound: [gid('gone')] })
    const gone = await request(makeApp()).get('/likes')
    expect(gone.body.likes[0]).toMatchObject({ status: 'gone', product: null })
    expect(gone.body.error).toBeUndefined()

    vi.mocked(lookupGlobalCatalog).mockRejectedValueOnce(new Error('timeout'))
    const failed = await request(makeApp()).get('/likes')
    expect(failed.status).toBe(200)
    expect(failed.body.likes[0]).toMatchObject({ status: 'unknown', product: null })
    expect(failed.body.error).toBe('catalog_unavailable')
  })

  it('pages with offset/limit and caps a page at the lookup maximum', async () => {
    for (let i = 0; i < 60; i++) insertLike('self', gid(`p${i}`), i)
    vi.mocked(lookupGlobalCatalog).mockResolvedValue({ products: [], notFound: [] })

    const first = await request(makeApp()).get('/likes?limit=500')
    expect(first.body.likes).toHaveLength(50)
    expect(first.body.nextOffset).toBe(50)
    expect(first.body.total).toBe(60)

    const second = await request(makeApp()).get('/likes?offset=50')
    expect(second.body.likes).toHaveLength(10)
    expect(second.body.nextOffset).toBeNull()
  })

  it('makes no catalog call when there are no likes', async () => {
    const res = await request(makeApp()).get('/likes')
    expect(res.body).toEqual({ likes: [], total: 0, nextOffset: null })
    expect(lookupGlobalCatalog).not.toHaveBeenCalled()
  })

  it('never returns or looks up another user\'s likes', async () => {
    insertLike('self', gid('mine'))
    const res = await request(makeApp('user_other')).get('/likes')
    expect(res.body.likes).toHaveLength(0)
    expect(lookupGlobalCatalog).not.toHaveBeenCalled()
  })

  it('GET /likes/ids lists only the caller\'s ids without a catalog call', async () => {
    insertLike('self', gid('a'))
    insertLike('user_other', gid('b'))
    const res = await request(makeApp()).get('/likes/ids')
    expect(res.body.productIds).toEqual([gid('a')])
    expect(lookupGlobalCatalog).not.toHaveBeenCalled()
  })
})

describe('Unlike', () => {
  it('DELETE /likes/:productId unlikes', async () => {
    insertLike('self', gid('p1'))
    const res = await request(makeApp()).delete(`/likes/${encodeURIComponent(gid('p1'))}`)
    expect(res.status).toBe(200)
    expect(db.select().from(likedProducts).all()).toHaveLength(0)
  })

  it('POST /likes/bulk-delete removes only the caller\'s likes', async () => {
    insertLike('self', gid('p1'))
    insertLike('self', gid('p2'))
    insertLike('user_other', gid('p3'))

    const res = await request(makeApp()).post('/likes/bulk-delete').send({ productIds: [gid('p1'), gid('p2'), gid('p3')] })
    expect(res.status).toBe(200)

    expect(db.select().from(likedProducts).where(eq(likedProducts.userId, 'self')).all()).toHaveLength(0)
    const theirs = db.select().from(likedProducts).where(eq(likedProducts.userId, 'user_other')).all()
    expect(theirs.map(l => l.productId)).toEqual([gid('p3')])
  })

  it('POST /likes/bulk-delete rejects non-string ids', async () => {
    const res = await request(makeApp()).post('/likes/bulk-delete').send({ productIds: [1, 2] })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /likes/:productId/saved-item', () => {
  function insertItem(id: string, userId: string) {
    const now = Date.now()
    db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: now, updatedAt: now }).run()
  }

  it('links a like to the caller\'s closet item', async () => {
    insertItem('item_1', 'self')
    insertLike('self', gid('p1'))

    const res = await request(makeApp()).patch(`/likes/${encodeURIComponent(gid('p1'))}/saved-item`).send({ savedItemId: 'item_1' })
    expect(res.status).toBe(200)
    const like = db.select().from(likedProducts)
      .where(and(eq(likedProducts.userId, 'self'), eq(likedProducts.productId, gid('p1')))).get()
    expect(like!.savedItemId).toBe('item_1')
  })

  it('deleting the closet item sets saved_item_id to NULL', async () => {
    insertItem('item_del', 'self')
    insertLike('self', gid('p1'), Date.now(), 'item_del')
    db.delete(items).where(eq(items.id, 'item_del')).run()

    const like = db.select().from(likedProducts).where(eq(likedProducts.productId, gid('p1'))).get()
    expect(like!.savedItemId).toBeNull()
  })

  it('refuses another user\'s item with the same 404 as an unknown id', async () => {
    insertItem('item_theirs', 'user_other')
    insertLike('self', gid('p1'))

    const path = `/likes/${encodeURIComponent(gid('p1'))}/saved-item`
    const foreign = await request(makeApp()).patch(path).send({ savedItemId: 'item_theirs' })
    const unknown = await request(makeApp()).patch(path).send({ savedItemId: 'item_nope' })
    expect(foreign.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(foreign.body).toEqual(unknown.body)

    const like = db.select().from(likedProducts).where(eq(likedProducts.productId, gid('p1'))).get()
    expect(like!.savedItemId).toBeNull()
  })

  it('404s for a like that belongs to someone else', async () => {
    insertItem('item_1', 'self')
    insertLike('user_other', gid('p1'))
    const res = await request(makeApp()).patch(`/likes/${encodeURIComponent(gid('p1'))}/saved-item`).send({ savedItemId: 'item_1' })
    expect(res.status).toBe(404)
  })
})

describe('no server-side image fetch (Shopify policy)', () => {
  it('the image proxy route is gone', async () => {
    insertLike('self', gid('p1'))
    const res = await request(makeApp()).post(`/likes/${encodeURIComponent(gid('p1'))}/image`)
    expect(res.status).toBe(404)
  })
})
