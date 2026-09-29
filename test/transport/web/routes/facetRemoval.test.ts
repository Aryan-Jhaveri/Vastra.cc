import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq, inArray } from 'drizzle-orm'

// #371 — removing the last tag or occasion must persist through the real
// route → tool → DB path for items, outfits and collections, and only for
// the owner. The after-save embedding refresh is stubbed (fire-and-forget).

vi.mock('../../../../src/ai/instrumented.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/ai/instrumented.js')>(),
  runEmbeddingInstrumented: vi.fn(),
}))

import { db } from '../../../../src/db/client.js'
import { collections, items, outfits, users } from '../../../../src/db/schema.js'
import itemsRouter from '../../../../src/transport/web/routes/items.js'
import outfitsRouter from '../../../../src/transport/web/routes/outfits.js'
import collectionsRouter from '../../../../src/transport/web/routes/collections.js'

const OWNER = 'user_facet_owner'
const OTHER = 'user_facet_other'

function app(userId: string) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.userId = userId; next() })
  a.use('/api/items', itemsRouter)
  a.use('/api/outfits', outfitsRouter)
  a.use('/api/collections', collectionsRouter)
  return a
}

beforeAll(() => {
  for (const id of [OWNER, OTHER]) {
    db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).onConflictDoNothing().run()
  }
})

beforeEach(() => {
  db.delete(collections).where(inArray(collections.userId, [OWNER, OTHER])).run()
  db.delete(outfits).where(inArray(outfits.userId, [OWNER, OTHER])).run()
  db.delete(items).where(inArray(items.userId, [OWNER, OTHER])).run()
  const now = Date.now()
  db.insert(items).values({
    id: 'facet_item', userId: OWNER, imageUri: 'images/items/f.jpg', category: 'tops',
    tags: JSON.stringify(['festival', 'linen']), occasion: JSON.stringify(['gala']), createdAt: now, updatedAt: now,
  }).run()
  db.insert(outfits).values({
    id: 'facet_outfit', userId: OWNER, name: 'Look', itemIds: JSON.stringify(['facet_item']),
    tags: JSON.stringify(['summer']), occasion: 'date night', createdAt: now,
  }).run()
  db.insert(collections).values({
    id: 'facet_col', userId: OWNER, name: 'Trip', tags: JSON.stringify(['packing']), createdAt: now, updatedAt: now,
  }).run()
})

const row = {
  item: () => db.select().from(items).where(eq(items.id, 'facet_item')).get()!,
  outfit: () => db.select().from(outfits).where(eq(outfits.id, 'facet_outfit')).get()!,
  col: () => db.select().from(collections).where(eq(collections.id, 'facet_col')).get()!,
}

describe('removing tags and occasions persists (#371)', () => {
  it('item: one tag, then the last tag and the last occasion', async () => {
    await request(app(OWNER)).patch('/api/items/facet_item').send({ tags: ['linen'] }).expect(200)
    expect(JSON.parse(row.item().tags)).toEqual(['linen'])
    await request(app(OWNER)).patch('/api/items/facet_item').send({ tags: [], occasion: [] }).expect(200)
    expect(JSON.parse(row.item().tags)).toEqual([])
    expect(JSON.parse(row.item().occasion ?? '[]')).toEqual([])
  })

  it('outfit: the last tag and the occasion ("" clears it)', async () => {
    const res = await request(app(OWNER)).patch('/api/outfits/facet_outfit').send({ tags: [], occasion: '' }).expect(200)
    expect(res.body.occasion).toBeNull()
    expect(JSON.parse(row.outfit().tags)).toEqual([])
    expect(row.outfit().occasion).toBeNull()
  })

  it('collection: the last tag', async () => {
    await request(app(OWNER)).patch('/api/collections/facet_col').send({ tags: [] }).expect(200)
    expect(JSON.parse(row.col().tags)).toEqual([])
  })

  it("another user can't clear them: 404 and nothing changes", async () => {
    await request(app(OTHER)).patch('/api/items/facet_item').send({ tags: [] }).expect(404)
    await request(app(OTHER)).patch('/api/outfits/facet_outfit').send({ tags: [], occasion: '' }).expect(404)
    await request(app(OTHER)).patch('/api/collections/facet_col').send({ tags: [] }).expect(404)
    expect(JSON.parse(row.item().tags)).toEqual(['festival', 'linen'])
    expect(row.outfit().occasion).toBe('date night')
    expect(JSON.parse(row.col().tags)).toEqual(['packing'])
  })
})
