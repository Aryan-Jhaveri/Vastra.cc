import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq, inArray } from 'drizzle-orm'

// #332 — Related shop items in ItemDetail: POST /api/shop/for-item/:id.
const { search, rank } = vi.hoisted(() => ({ search: vi.fn(), rank: vi.fn() }))
vi.mock('../../../../src/commerce/shopify/catalog.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/commerce/shopify/catalog.js')>(),
  searchGlobalCatalog: search,
}))
vi.mock('../../../../src/ai/shopRank.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/ai/shopRank.js')>(),
  rankShopProductsWithJev: rank,
}))

import { db } from '../../../../src/db/client.js'
import { items, relatedRequests, users } from '../../../../src/db/schema.js'
import shopRouter from '../../../../src/transport/web/routes/shop.js'
import { itemShopQuery } from '../../../../src/commerce/itemShopQuery.js'

const A = 'shopitem-a'
const B = 'shopitem-b'
const product = (id: string) => ({ id: `gid://shopify/p/${id}`, title: id, imageUrl: null, price: null, merchant: 'M', url: null, available: true })

function appAs(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.use('/', shopRouter)
  return app
}
function seedItem(userId: string, id: string, extra: Partial<typeof items.$inferInsert> = {}) {
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', subcategory: 'oxford shirt', primaryColor: 'White', material: 'cotton', brand: 'SecretBrand', size: 'XL', createdAt: 1, updatedAt: 1, ...extra }).run()
}
const logRows = () => db.select().from(relatedRequests).where(eq(relatedRequests.userId, A)).all()

beforeAll(() => {
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) db.insert(users).values({ id, email: `${id}@t.co`, createdAt: 1 }).run()
  }
})
beforeEach(() => {
  search.mockReset()
  rank.mockReset()
  db.delete(relatedRequests).where(inArray(relatedRequests.userId, [A, B])).run()
  db.delete(items).where(inArray(items.userId, [A, B])).run()
  seedItem(A, 'shirt-a')
  seedItem(B, 'shirt-b')
})
afterEach(() => vi.unstubAllEnvs())

describe('itemShopQuery', () => {
  it('describes what completes the item, from its own attributes only', () => {
    expect(itemShopQuery({ category: 'tops', subcategory: 'Oxford shirt', primaryColor: 'White', material: 'cotton' }))
      .toBe('bottoms, outerwear or shoes to wear with a white cotton oxford shirt')
  })
})

describe('POST /for-item/:id', () => {
  it('sends only the derived query (no id, brand or size) and ranks against the item', async () => {
    search.mockResolvedValue({ products: [product('a'), product('b')], nextCursor: 'c1', details: {} })
    rank.mockImplementation(async (o: { products: unknown[] }) => [...o.products].reverse())
    const res = await request(appAs(A)).post('/for-item/shirt-a').send({})
    expect(res.status).toBe(200)
    expect(res.body.ranked).toBe(true)
    expect(res.body.products.map((p: { title: string }) => p.title)).toEqual(['b', 'a'])
    const sent = JSON.stringify(search.mock.calls[0][0])
    expect(sent).toContain('to wear with a white cotton oxford shirt')
    for (const secret of ['shirt-a', 'SecretBrand', 'XL', A]) expect(sent).not.toContain(secret)
    expect(rank.mock.calls[0][0].context.items.map((i: { id: string }) => i.id)).toEqual(['shirt-a'])
    expect(rank.mock.calls[0][0].runId).toBe(logRows()[0].id)
  })

  it('404s for another user\'s item, with no catalog call and no log row', async () => {
    const res = await request(appAs(A)).post('/for-item/shirt-b').send({})
    expect(res.status).toBe(404)
    expect(search).not.toHaveBeenCalled()
    expect(logRows()).toHaveLength(0)
  })

  it('the first page counts toward the Find related cap; More pages do not', async () => {
    search.mockResolvedValue({ products: [product('a')], nextCursor: 'c1', details: {} })
    await request(appAs(A)).post('/for-item/shirt-a').send({})
    await request(appAs(A)).post('/for-item/shirt-a').send({ cursor: 'c1' })
    const rows = logRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'item_shop', status: 'success', countsTowardCap: 1 })
  })

  it('shares the daily cap with Find related (429 once it is used up)', async () => {
    vi.stubEnv('RELATED_DAILY_LIMIT', '1')
    search.mockResolvedValue({ products: [product('a')], nextCursor: null, details: {} })
    expect((await request(appAs(A)).post('/for-item/shirt-a').send({})).status).toBe(200)
    const capped = await request(appAs(A)).post('/for-item/shirt-a').send({})
    expect(capped.status).toBe(429)
    expect(capped.body.error).toBe('related_daily_limit')
  })

  it('a catalog error is a 502 that does not use quota', async () => {
    search.mockRejectedValue(new Error('timeout'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await request(appAs(A)).post('/for-item/shirt-a').send({})
    expect(res.status).toBe(502)
    expect(logRows()[0]).toMatchObject({ status: 'error', countsTowardCap: 0 })
  })

  it('keeps catalog order when ranking fails', async () => {
    search.mockResolvedValue({ products: [product('a'), product('b')], nextCursor: null, details: {} })
    rank.mockRejectedValue(new Error('no decision provider'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await request(appAs(A)).post('/for-item/shirt-a').send({})
    expect(res.body).toMatchObject({ ranked: false })
    expect(res.body.products.map((p: { title: string }) => p.title)).toEqual(['a', 'b'])
  })
})
