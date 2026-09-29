import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

// #324 — Related shop row ranked by Jev against related items, outfits and AI
// recommendations. The catalog and the Jev HTTP call are mocked; the ranker,
// instrumentation and user-scoped lookups run for real.
vi.mock('../../../../src/commerce/shopify/catalog.js', () => ({
  searchGlobalCatalog: vi.fn(),
  lookupGlobalCatalog: vi.fn(),
  LOOKUP_MAX_IDS: 50,
}))
vi.mock('../../../../src/ai/decisions.js', async (orig) => ({
  ...(await orig<typeof import('../../../../src/ai/decisions.js')>()),
  generateDecisions: vi.fn(),
}))

import { searchGlobalCatalog, type ShopProduct } from '../../../../src/commerce/shopify/catalog.js'
import { generateDecisions } from '../../../../src/ai/decisions.js'
import { db } from '../../../../src/db/client.js'
import { users, items, outfits, aiCalls } from '../../../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import shopRouter from '../../../../src/transport/web/routes/shop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const gid = (s: string) => `gid://shopify/p/${s}`

function product(id: string): ShopProduct {
  return { id, title: `Title ${id}`, imageUrl: null, price: null, merchant: 'M', url: null, available: true }
}

function catalogPage(ids: string[], nextCursor: string | null = null) {
  const products = ids.map(id => product(gid(id)))
  const details = Object.fromEntries(products.map(p => [p.id, { title: p.title, description: `about ${p.id}` }]))
  return { products, nextCursor, details }
}

/** Jev answers p0..pN with the given Noul scores. */
function jevScores(scores: number[]) {
  vi.mocked(generateDecisions).mockResolvedValue({
    answers: Object.fromEntries(scores.map((noul, i) => [`p${i}`, { type: 'noul' as const, noul }])),
    usage: { cost: 0.0001, inputTokens: 10, outputTokens: 5 },
    model: 'typesafe/jev-1.13',
    id: 'dec_1',
  })
}

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../../../src/db/migrations') })
  for (const id of ['self', 'user_other']) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

function makeApp(userId = 'self') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = userId; req.authVia = 'cookie'; next() })
  app.use('/', shopRouter)
  return app
}

function insertItem(id: string, userId: string, extra: Record<string, unknown> = {}) {
  const now = Date.now()
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: now, updatedAt: now, ...extra }).run()
}

function insertOutfit(id: string, userId: string, itemIds: string[]) {
  db.insert(outfits).values({ id, userId, name: `Outfit ${id}`, itemIds: JSON.stringify(itemIds), createdAt: Date.now() }).run()
}

beforeEach(() => {
  vi.clearAllMocks()
  db.delete(aiCalls).run()
  db.delete(outfits).run()
  db.delete(items).run()
})

describe('POST /api/shop/related — Jev ranking', () => {
  it('pulls a 24-product pool and returns it best match first', async () => {
    insertItem('i1', 'self', { primaryColor: 'navy', subcategory: 'linen shirt' })
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b', 'c'], 'next1'))
    jevScores([0.2, 0.9, 0.5])

    const res = await request(makeApp()).post('/related').send({
      query: 'linen shirt',
      context: { itemIds: ['i1'], outfitIds: [], recommendations: [] },
    })

    expect(res.status).toBe(200)
    expect(res.body.ranked).toBe(true)
    expect(res.body.products.map((p: ShopProduct) => p.id)).toEqual([gid('b'), gid('c'), gid('a')])
    expect(res.body.nextCursor).toBe('next1')
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0].limit).toBe(24)
  })

  it('sends related items, outfits and recommendations as state, and product details as questions', async () => {
    insertItem('i1', 'self', { primaryColor: 'navy' })
    insertItem('i2', 'self', { primaryColor: 'white' })
    insertOutfit('o1', 'self', ['i2'])
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b']))
    jevScores([0.5, 0.4])

    await request(makeApp()).post('/related').send({
      query: 'shirt',
      intent: 'Outfit for 20°C',
      context: {
        itemIds: ['i1'],
        outfitIds: ['o1'],
        recommendations: [{ name: 'Weekend', occasion: 'casual', reasoning: 'Light layers', itemIds: ['i1', 'i2'] }],
      },
    })

    const [state, questions] = vi.mocked(generateDecisions).mock.calls[0]
    const s = state as Record<string, unknown>
    expect(s.shop_query).toBe('shirt')
    expect(s.intent).toBe('Outfit for 20°C')
    expect(s.related_closet_items).toEqual([expect.objectContaining({ primaryColor: 'navy' })])
    expect(s.related_outfits).toEqual([expect.objectContaining({ name: 'Outfit o1', items: [expect.objectContaining({ primaryColor: 'white' })] })])
    expect(s.outfit_recommendations).toEqual([expect.objectContaining({ name: 'Weekend', reasoning: 'Light layers' })])
    // No ids or user identifiers in state.
    expect(JSON.stringify(state)).not.toMatch(/"i1"|"o1"|self/)
    expect(Object.keys(questions)).toEqual(['p0', 'p1'])
    expect(JSON.stringify(questions.p0)).toContain(`about ${gid('a')}`)
  })

  it('records the Jev call as a free shop_rank ai_calls row', async () => {
    insertItem('i1', 'self')
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b']))
    jevScores([0.1, 0.2])
    await request(makeApp()).post('/related').send({ query: 'q', context: { itemIds: ['i1'] } })
    const rows = db.select().from(aiCalls).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ task: 'shop_rank', provider: 'typesafe', billedTokens: 0, userId: 'self' })
  })

  it('drops another user\'s item and outfit ids silently (no 4xx oracle)', async () => {
    insertItem('mine', 'self', { primaryColor: 'navy' })
    insertItem('theirs', 'user_other', { primaryColor: 'crimson' })
    insertOutfit('their_outfit', 'user_other', ['theirs'])
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b']))
    jevScores([0.1, 0.2])

    const res = await request(makeApp()).post('/related').send({
      query: 'q',
      context: { itemIds: ['mine', 'theirs', 'nope'], outfitIds: ['their_outfit'], recommendations: [{ name: 'X', itemIds: ['theirs'] }] },
    })

    expect(res.status).toBe(200)
    const state = vi.mocked(generateDecisions).mock.calls[0][0]
    expect(JSON.stringify(state)).not.toContain('crimson')
    expect((state as Record<string, unknown>).related_outfits).toBeUndefined()
    expect((state as Record<string, unknown>).outfit_recommendations).toBeUndefined()
  })

  it('falls back to catalog order when Jev fails', async () => {
    insertItem('i1', 'self')
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b', 'c']))
    vi.mocked(generateDecisions).mockRejectedValue(new Error('decisions HTTP 503'))

    const res = await request(makeApp()).post('/related').send({ query: 'q', context: { itemIds: ['i1'] } })
    expect(res.status).toBe(200)
    expect(res.body.ranked).toBe(false)
    expect(res.body.products.map((p: ShopProduct) => p.id)).toEqual([gid('a'), gid('b'), gid('c')])
  })

  it('keeps products Jev did not answer, after the scored ones, in catalog order', async () => {
    insertItem('i1', 'self')
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b', 'c', 'd']))
    vi.mocked(generateDecisions).mockResolvedValue({
      answers: { p1: { type: 'noul', noul: 0.3 }, p3: { type: 'noul', noul: 0.8 } },
      usage: { cost: 0, inputTokens: 0, outputTokens: 0 }, model: null, id: null,
    })
    const res = await request(makeApp()).post('/related').send({ query: 'q', context: { itemIds: ['i1'] } })
    expect(res.body.products.map((p: ShopProduct) => p.id)).toEqual([gid('d'), gid('b'), gid('a'), gid('c')])
  })

  it('without context (or with only foreign ids) keeps the unranked 10-product page and skips Jev', async () => {
    insertItem('theirs', 'user_other')
    vi.mocked(searchGlobalCatalog).mockResolvedValue(catalogPage(['a', 'b']))
    const plain = await request(makeApp()).post('/related').send({ query: 'q' })
    const foreign = await request(makeApp()).post('/related').send({ query: 'q', context: { itemIds: ['theirs'] } })
    for (const res of [plain, foreign]) {
      expect(res.status).toBe(200)
      expect(res.body.ranked).toBe(false)
    }
    expect(vi.mocked(searchGlobalCatalog).mock.calls.map(c => c[0].limit)).toEqual([10, 10])
    expect(generateDecisions).not.toHaveBeenCalled()
  })

  it('rejects a malformed context with 400 before calling the catalog', async () => {
    const bodies = [
      { context: 'nope' },
      { context: { itemIds: 'i1' } },
      { context: { itemIds: [42] } },
      { context: { itemIds: Array.from({ length: 100 }, (_, i) => `i${i}`) } },
      { context: { recommendations: [{ name: 'x'.repeat(600) }] } },
      { context: { recommendations: 'x' } },
    ]
    for (const b of bodies) {
      const res = await request(makeApp()).post('/related').send({ query: 'q', ...b })
      expect(res.status).toBe(400)
    }
    expect(searchGlobalCatalog).not.toHaveBeenCalled()
  })
})
