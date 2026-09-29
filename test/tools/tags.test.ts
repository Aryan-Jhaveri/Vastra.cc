import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { collections, items, outfits, users } from '../../src/db/schema.js'
import { deleteFacetEverywhere, listFacetUsage } from '../../src/tools/tags.js'
import tagsRouter from '../../src/transport/web/routes/tags.js'

// #372 — created tags / occasions: usage counts and deleting one everywhere,
// per user only.

const A = 'user_tags_a'
const B = 'user_tags_b'

beforeAll(() => {
  for (const id of [A, B]) db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).onConflictDoNothing().run()
})

beforeEach(() => {
  for (const t of [collections, outfits, items] as const) db.delete(t).where(inArray(t.userId, [A, B])).run()
  const now = Date.now()
  const item = (id: string, userId: string, tags: string[], occasion: string[]) =>
    db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', tags: JSON.stringify(tags), occasion: JSON.stringify(occasion), createdAt: now, updatedAt: now }).run()
  item('ta1', A, ['festival', 'linen'], ['gala', 'work'])
  item('ta2', A, ['Festival'], ['gala'])
  item('ta3', A, ['denim'], [])
  item('tb1', B, ['festival'], ['gala'])
  db.insert(outfits).values({ id: 'to1', userId: A, name: 'O', itemIds: '[]', tags: JSON.stringify(['festival']), occasion: 'gala', createdAt: now }).run()
  db.insert(outfits).values({ id: 'to2', userId: A, name: 'P', itemIds: '[]', tags: '[]', occasion: 'work', createdAt: now }).run()
  db.insert(collections).values({ id: 'tc1', userId: A, name: 'C', tags: JSON.stringify(['festival', 'trip']), createdAt: now, updatedAt: now }).run()
})

const tagsOf = (id: string) => JSON.parse(db.select().from(items).where(eq(items.id, id)).get()!.tags) as string[]

describe('listFacetUsage', () => {
  it('counts each created tag across items, outfits and collections, most used first', () => {
    expect(listFacetUsage(A, 'tag')).toEqual([
      { value: 'festival', items: 2, outfits: 1, collections: 1 },
      { value: 'denim', items: 1, outfits: 0, collections: 0 },
      { value: 'linen', items: 1, outfits: 0, collections: 0 },
      { value: 'trip', items: 0, outfits: 0, collections: 1 },
    ])
  })

  it('counts occasions on items (lists) and outfits (single value)', () => {
    expect(listFacetUsage(A, 'occasion')).toEqual([
      { value: 'gala', items: 2, outfits: 1, collections: 0 },
      { value: 'work', items: 1, outfits: 1, collections: 0 },
    ])
  })

  it('requires a user', () => {
    expect(() => listFacetUsage('', 'tag')).toThrow(/userId is required/)
  })
})

describe('deleteFacetEverywhere', () => {
  it('removes a tag from every item, outfit and collection of this user only', () => {
    expect(deleteFacetEverywhere(A, 'tag', ['FESTIVAL '])).toEqual({ items: 2, outfits: 1, collections: 1 })
    expect(tagsOf('ta1')).toEqual(['linen'])
    expect(tagsOf('ta2')).toEqual([])
    expect(JSON.parse(db.select().from(outfits).where(eq(outfits.id, 'to1')).get()!.tags)).toEqual([])
    expect(JSON.parse(db.select().from(collections).where(eq(collections.id, 'tc1')).get()!.tags)).toEqual(['trip'])
    expect(tagsOf('tb1')).toEqual(['festival'])
  })

  it('removes an occasion from item lists and clears it on outfits', () => {
    expect(deleteFacetEverywhere(A, 'occasion', ['gala'])).toEqual({ items: 2, outfits: 1, collections: 0 })
    expect(JSON.parse(db.select().from(items).where(eq(items.id, 'ta1')).get()!.occasion!)).toEqual(['work'])
    expect(db.select().from(outfits).where(eq(outfits.id, 'to1')).get()!.occasion).toBeNull()
    expect(db.select().from(outfits).where(eq(outfits.id, 'to2')).get()!.occasion).toBe('work')
    expect(JSON.parse(db.select().from(items).where(eq(items.id, 'tb1')).get()!.occasion!)).toEqual(['gala'])
  })
})

describe('/api/tags', () => {
  const app = (userId: string) => {
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => { req.userId = userId; next() })
    a.use('/api/tags', tagsRouter)
    return a
  }

  it('lists and deletes for the signed-in user; bad input is 400', async () => {
    const list = await request(app(A)).get('/api/tags?kind=tag').expect(200)
    expect(list.body.values[0]).toEqual({ value: 'festival', items: 2, outfits: 1, collections: 1 })
    await request(app(A)).get('/api/tags?kind=color').expect(400)
    await request(app(A)).post('/api/tags/delete').send({ kind: 'tag', values: [] }).expect(400)

    const res = await request(app(B)).post('/api/tags/delete').send({ kind: 'tag', values: ['festival'] }).expect(200)
    expect(res.body).toEqual({ items: 1, outfits: 0, collections: 0 })
    expect(tagsOf('ta1')).toEqual(['festival', 'linen'])
  })
})
