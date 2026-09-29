import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../../../../src/db/client.js'
import { items, outfits, users } from '../../../../src/db/schema.js'
import outfitsRouter from '../../../../src/transport/web/routes/outfits.js'

// GET /api/outfits/:id against the real DB: hydrated for the owner, 404 for anyone else.

const U = 'self'
const OTHER = 'user_outfit_get_other'

function makeApp(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = userId; next() })
  app.use('/api/outfits', outfitsRouter)
  return app
}

beforeAll(() => {
  if (!db.select().from(users).where(eq(users.id, OTHER)).get()) {
    db.insert(users).values({ id: OTHER, email: `${OTHER}@local.closet`, createdAt: Date.now() }).run()
  }
})

beforeEach(() => {
  db.delete(outfits).run()
  db.delete(items).run()
  const now = Date.now()
  db.insert(items).values({ id: 'og_item', userId: U, imageUri: 'images/items/og.jpg', category: 'tops', createdAt: now, updatedAt: now }).run()
  db.insert(outfits).values({ id: 'og_outfit', userId: U, name: 'Mine', itemIds: '["og_item"]', season: '[]', tags: '[]', createdAt: now, timesWorn: 0 }).run()
})

describe('GET /api/outfits/:id', () => {
  it('returns the owner outfit with items', async () => {
    const res = await request(makeApp(U)).get('/api/outfits/og_outfit')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'og_outfit', name: 'Mine', items: [expect.objectContaining({ id: 'og_item' })] })
  })

  it('404s for another user and for an unknown id', async () => {
    expect((await request(makeApp(OTHER)).get('/api/outfits/og_outfit')).status).toBe(404)
    expect((await request(makeApp(U)).get('/api/outfits/nope')).status).toBe(404)
  })
})
