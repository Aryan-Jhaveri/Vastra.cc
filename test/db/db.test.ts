import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as schema from '../../src/db/schema.js'
import { items, outfits, userPhotos, tryonResults } from '../../src/db/schema.js'
import { nanoid } from 'nanoid'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Use an in-memory database for tests
let sqlite: InstanceType<typeof Database>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

afterAll(() => {
  sqlite.close()
})

beforeEach(() => {
  // Clear all tables between tests
  sqlite.exec('DELETE FROM tryon_results; DELETE FROM outfits; DELETE FROM user_photos; DELETE FROM items;')
})

// ─── Items ────────────────────────────────────────────────────────────────────

describe('items', () => {
  it('inserts and retrieves an item', () => {
    const now = Date.now()
    const result = db.insert(items).values({
      id: nanoid(),
      imageUri: 'images/items/test.jpg',
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'black',
      colors: JSON.stringify(['black']),
      season: JSON.stringify(['spring', 'summer']),
      tags: JSON.stringify(['casual']),
      occasion: JSON.stringify(['casual']),
      careInstructions: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    }).returning().get()

    expect(result).toBeDefined()
    expect(result.category).toBe('tops')
    expect(result.primaryColor).toBe('black')
  })

  it('queries items by category', () => {
    const now = Date.now()
    const id1 = nanoid()
    const id2 = nanoid()

    db.insert(items).values([
      { id: id1, imageUri: 'a.jpg', category: 'tops', colors: '[]', season: '[]', tags: '[]', occasion: '[]', careInstructions: '[]', createdAt: now, updatedAt: now },
      { id: id2, imageUri: 'b.jpg', category: 'bottoms', colors: '[]', season: '[]', tags: '[]', occasion: '[]', careInstructions: '[]', createdAt: now, updatedAt: now },
    ]).run()

    const tops = db.select().from(items).where(eq(items.category, 'tops')).all()
    expect(tops).toHaveLength(1)
    expect(tops[0].id).toBe(id1)
  })

  it('updates an item', () => {
    const now = Date.now()
    const id = nanoid()
    db.insert(items).values({
      id, imageUri: 'x.jpg', category: 'tops', colors: '[]', season: '[]', tags: '[]', occasion: '[]', careInstructions: '[]', createdAt: now, updatedAt: now,
    }).run()

    const updated = db.update(items).set({ brand: 'Nike', updatedAt: Date.now() }).where(eq(items.id, id)).returning().get()
    expect(updated?.brand).toBe('Nike')
  })

  it('deletes an item', () => {
    const now = Date.now()
    const id = nanoid()
    db.insert(items).values({
      id, imageUri: 'del.jpg', category: 'shoes', colors: '[]', season: '[]', tags: '[]', occasion: '[]', careInstructions: '[]', createdAt: now, updatedAt: now,
    }).run()

    db.delete(items).where(eq(items.id, id)).run()
    const result = db.select().from(items).where(eq(items.id, id)).get()
    expect(result).toBeUndefined()
  })

  it('increments timesWorn', () => {
    const now = Date.now()
    const id = nanoid()
    db.insert(items).values({
      id, imageUri: 'worn.jpg', category: 'tops', timesWorn: 0, colors: '[]', season: '[]', tags: '[]', occasion: '[]', careInstructions: '[]', createdAt: now, updatedAt: now,
    }).run()

    db.update(items).set({ timesWorn: 1, lastWornAt: Date.now(), updatedAt: Date.now() }).where(eq(items.id, id)).run()
    const result = db.select().from(items).where(eq(items.id, id)).get()
    expect(result?.timesWorn).toBe(1)
    expect(result?.lastWornAt).toBeDefined()
  })
})

// ─── Outfits ──────────────────────────────────────────────────────────────────

describe('outfits', () => {
  it('inserts and retrieves an outfit', () => {
    const result = db.insert(outfits).values({
      id: nanoid(),
      name: 'Weekend Casual',
      itemIds: JSON.stringify(['a', 'b']),
      occasion: 'casual',
      season: JSON.stringify(['spring']),
      aiGenerated: 0,
      timesWorn: 0,
      createdAt: Date.now(),
    }).returning().get()

    expect(result.name).toBe('Weekend Casual')
    expect(JSON.parse(result.itemIds)).toEqual(['a', 'b'])
  })

  it('updates outfit timesWorn', () => {
    const id = nanoid()
    db.insert(outfits).values({
      id, name: 'Look', itemIds: '[]', timesWorn: 0, createdAt: Date.now(),
    }).run()

    db.update(outfits).set({ timesWorn: 3, lastWornAt: Date.now() }).where(eq(outfits.id, id)).run()
    const result = db.select().from(outfits).where(eq(outfits.id, id)).get()
    expect(result?.timesWorn).toBe(3)
  })

  it('deletes an outfit', () => {
    const id = nanoid()
    db.insert(outfits).values({ id, name: 'Temp', itemIds: '[]', timesWorn: 0, createdAt: Date.now() }).run()
    db.delete(outfits).where(eq(outfits.id, id)).run()
    expect(db.select().from(outfits).where(eq(outfits.id, id)).get()).toBeUndefined()
  })
})

// ─── User Photos ──────────────────────────────────────────────────────────────

describe('user_photos', () => {
  it('inserts and retrieves a user photo', () => {
    const result = db.insert(userPhotos).values({
      id: nanoid(),
      imageUri: 'images/user/me.jpg',
      label: 'Front view',
      isPrimary: 1,
      createdAt: Date.now(),
    }).returning().get()

    expect(result.label).toBe('Front view')
    expect(result.isPrimary).toBe(1)
  })

  it('sets and unsets primary photo', () => {
    const id1 = nanoid()
    const id2 = nanoid()
    const now = Date.now()
    db.insert(userPhotos).values([
      { id: id1, imageUri: 'a.jpg', isPrimary: 1, createdAt: now },
      { id: id2, imageUri: 'b.jpg', isPrimary: 0, createdAt: now },
    ]).run()

    // Unset all, set id2
    db.update(userPhotos).set({ isPrimary: 0 }).run()
    db.update(userPhotos).set({ isPrimary: 1 }).where(eq(userPhotos.id, id2)).run()

    const primary = db.select().from(userPhotos).where(eq(userPhotos.isPrimary, 1)).get()
    expect(primary?.id).toBe(id2)
  })
})

// ─── Tryon Results ────────────────────────────────────────────────────────────

describe('tryon_results', () => {
  it('inserts and retrieves a tryon result', () => {
    const photoId = nanoid()
    db.insert(userPhotos).values({ id: photoId, imageUri: 'user.jpg', isPrimary: 0, createdAt: Date.now() }).run()

    const result = db.insert(tryonResults).values({
      id: nanoid(),
      userPhotoId: photoId,
      itemIds: JSON.stringify(['item1', 'item2']),
      resultImageUri: 'images/tryon/result.jpg',
      createdAt: Date.now(),
    }).returning().get()

    expect(result.userPhotoId).toBe(photoId)
    expect(JSON.parse(result.itemIds)).toEqual(['item1', 'item2'])
  })

  it('deletes a tryon result', () => {
    const photoId = nanoid()
    db.insert(userPhotos).values({ id: photoId, imageUri: 'user.jpg', isPrimary: 0, createdAt: Date.now() }).run()

    const id = nanoid()
    db.insert(tryonResults).values({
      id, userPhotoId: photoId, itemIds: '[]', resultImageUri: 'r.jpg', createdAt: Date.now(),
    }).run()
    db.delete(tryonResults).where(eq(tryonResults.id, id)).run()
    expect(db.select().from(tryonResults).where(eq(tryonResults.id, id)).get()).toBeUndefined()
  })
})
