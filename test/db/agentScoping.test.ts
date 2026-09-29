import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { items, outfits, collections, collectionOutfits, itemImages } from '../../src/db/schema.js'
import * as queries from '../../src/db/queries.js'
import { listItems, countItems, listItemCards } from '../../src/tools/items.js'
import { getOutfit, getOutfitWithItems } from '../../src/tools/outfits.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(itemImages).run()
  db.delete(collectionOutfits).run()
  db.delete(collections).run()
  db.delete(outfits).run()
  db.delete(items).run()
})

function seedItem(userId: string, id: string) {
  const now = Date.now()
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops',
    createdAt: now, updatedAt: now,
  }).run()
}

function seedOutfit(userId: string, id: string, itemIds: string[] = []) {
  db.insert(outfits).values({
    id, userId, name: id, itemIds: JSON.stringify(itemIds), createdAt: Date.now(),
  }).run()
}

function seedCollection(userId: string, id: string) {
  const now = Date.now()
  db.insert(collections).values({ id, userId, name: id, createdAt: now, updatedAt: now }).run()
}

// An agent-invoked tool must never be able to reach another tenant's closet by
// simply omitting the identity argument.
describe('item tools require an authenticated user', () => {
  beforeEach(() => {
    seedItem('alice', 'alice-item')
    seedItem('bob', 'bob-item')
  })

  it('rejects an omitted or blank userId at runtime', async () => {
    await expect(listItems({}, undefined as unknown as string)).rejects.toThrow(/userId is required/)
    await expect(countItems({}, '' as string)).rejects.toThrow(/userId is required/)
    await expect(listItemCards({}, '   ')).rejects.toThrow(/userId is required/)
  })

  it('never returns another user\'s items', async () => {
    expect((await listItems({}, 'alice')).map(i => i.id)).toEqual(['alice-item'])
    expect(await countItems({}, 'alice')).toBe(1)
    expect((await listItemCards({}, 'bob')).map(i => i.id)).toEqual(['bob-item'])
  })
})

describe('outfit reads are always scoped', () => {
  beforeEach(() => {
    seedItem('alice', 'alice-item')
    seedOutfit('alice', 'alice-outfit', ['alice-item'])
  })

  it('rejects unscoped reads', async () => {
    await expect(getOutfit('alice-outfit', undefined as unknown as string)).rejects.toThrow(/userId is required/)
    await expect(getOutfitWithItems('alice-outfit', '')).rejects.toThrow(/userId is required/)
  })

  it('hides another user\'s outfit and its items', async () => {
    expect(await getOutfit('alice-outfit', 'bob')).toBeNull()
    expect(await getOutfitWithItems('alice-outfit', 'bob')).toBeNull()
    expect((await getOutfitWithItems('alice-outfit', 'alice'))?.items.map(i => i.id)).toEqual(['alice-item'])
  })
})

describe('collection membership is scoped on both sides of the join', () => {
  beforeEach(() => {
    seedCollection('alice', 'alice-col')
    seedOutfit('alice', 'alice-outfit')
    seedOutfit('bob', 'bob-outfit')
  })

  it('refuses to add an outfit owned by another user', () => {
    expect(() => queries.addOutfitsToCollection('alice-col', ['bob-outfit'], 'alice')).toThrow(/Outfit not found/)
    expect(queries.getOutfitIdsInCollection('alice-col', 'alice')).toEqual([])
  })

  it('refuses to add to a collection owned by another user', () => {
    expect(() => queries.addOutfitsToCollection('alice-col', ['bob-outfit'], 'bob')).toThrow(/Collection not found/)
  })

  it('does not let another user read or mutate membership', () => {
    queries.addOutfitsToCollection('alice-col', ['alice-outfit'], 'alice')

    expect(queries.getOutfitIdsInCollection('alice-col', 'bob')).toEqual([])
    expect(queries.getCollectionIdsForOutfit('alice-outfit', 'bob')).toEqual([])

    queries.removeOutfitFromCollection('alice-col', 'alice-outfit', 'bob')
    expect(queries.getOutfitIdsInCollection('alice-col', 'alice')).toEqual(['alice-outfit'])
  })

  it('requires an explicit userId', () => {
    expect(() => queries.getOutfitIdsInCollection('alice-col', undefined as unknown as string)).toThrow(/userId is required/)
    expect(() => queries.getCollectionIdsForOutfit('alice-outfit', '')).toThrow(/userId is required/)
  })
})

describe('item image helpers are user-scoped, not id-scoped', () => {
  beforeEach(() => {
    seedItem('alice', 'alice-item')
    seedItem('bob', 'bob-item')
  })

  it('rejects writes against another user\'s item', () => {
    expect(() => queries.insertItemImage({
      userId: 'bob', itemId: 'alice-item', imageUri: 'images/items/x.jpg',
      role: 'reference', isPrimary: 0, position: 0,
    })).toThrow(/Item not found/)
  })

  it('does not leak or delete images by id alone', () => {
    const image = queries.insertItemImage({
      userId: 'alice', itemId: 'alice-item', imageUri: 'images/items/a.jpg',
      role: 'reference', isPrimary: 1, position: 0,
    })

    expect(queries.getItemImages('alice-item', 'bob')).toEqual([])
    expect(queries.getItemImage(image.id, 'bob')).toBeUndefined()

    queries.deleteItemImage(image.id, 'bob')
    expect(queries.getItemImage(image.id, 'alice')).toBeDefined()

    expect(() => queries.setItemImagePrimary('alice-item', image.id, 'bob')).toThrow(/not found/)
    expect(() => queries.getItemImages('alice-item', undefined as unknown as string)).toThrow(/userId is required/)
  })
})
