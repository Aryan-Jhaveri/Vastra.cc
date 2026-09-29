import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { items, itemImages, collectionOutfits, collections, outfits } from '../../src/db/schema.js'
import { searchItems, searchTokens, escapeLike } from '../../src/db/queries.js'

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

function seed(userId: string, id: string, fields: Partial<typeof items.$inferInsert> = {}) {
  const now = Date.now()
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops',
    createdAt: now, updatedAt: now, ...fields,
  }).run()
}

const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort()

describe('searchTokens', () => {
  it('lowercases, splits, strips joiners and a plural s', () => {
    expect(searchTokens('Tan  T-Shirts, coats')).toEqual(['tan', 'tshirt', 'coat'])
    expect(searchTokens('dress')).toEqual(['dress'])
    expect(searchTokens('% _ ')).toEqual([])
  })

  it('escapeLike escapes wildcards and the escape char', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\')
  })
})

describe('searchItems (#364)', () => {
  it('"trenchcoat" finds an item described as "trench coat" and vice versa', () => {
    seed('alice', 'trench', { category: 'outerwear', aiDescription: 'A tan trench coat with belt' })
    seed('alice', 'solid', { category: 'outerwear', subcategory: 'trenchcoat' })
    seed('alice', 'tee', { aiDescription: 'plain white tee' })
    expect(ids(searchItems('trenchcoat', 'alice'))).toEqual(['solid', 'trench'])
    expect(ids(searchItems('trench coat', 'alice'))).toEqual(['solid', 'trench'])
    expect(ids(searchItems('Trench-Coat', 'alice'))).toEqual(['solid', 'trench'])
  })

  it('"tshirt" finds "t-shirt"', () => {
    seed('alice', 'ts', { subcategory: 't-shirt' })
    expect(ids(searchItems('tshirt', 'alice'))).toEqual(['ts'])
    expect(ids(searchItems('t shirts', 'alice'))).toEqual(['ts'])
  })

  it('matches category (not just subcategory) and colors', () => {
    seed('alice', 'coat', { category: 'outerwear', colors: JSON.stringify(['navy']) })
    seed('alice', 'shirt', { category: 'tops', colors: JSON.stringify(['white']) })
    expect(ids(searchItems('outerwear', 'alice'))).toEqual(['coat'])
    expect(ids(searchItems('navy', 'alice'))).toEqual(['coat'])
  })

  it('requires every token to match, each in any field', () => {
    seed('alice', 'navy-coat', { category: 'outerwear', primaryColor: 'navy', brand: 'Uniqlo' })
    seed('alice', 'navy-tee', { category: 'tops', primaryColor: 'navy' })
    seed('alice', 'black-coat', { category: 'outerwear', primaryColor: 'black' })
    expect(ids(searchItems('navy outerwear', 'alice'))).toEqual(['navy-coat'])
    expect(ids(searchItems('uniqlo navy', 'alice'))).toEqual(['navy-coat'])
    expect(searchItems('navy dress', 'alice')).toEqual([])
  })

  it('treats LIKE wildcards literally instead of matching everything', () => {
    seed('alice', 'a', { aiDescription: 'wool sweater' })
    seed('alice', 'b', { aiDescription: 'cotton shirt' })
    expect(searchItems('%', 'alice')).toEqual([])
    expect(searchItems('_', 'alice')).toEqual([])
    expect(searchItems('%%%', 'alice')).toEqual([])
    expect(ids(searchItems('wo%', 'alice'))).toEqual(['a'])
    expect(searchItems('   ', 'alice')).toEqual([])
  })

  it('never returns another user\'s items', () => {
    seed('alice', 'alice-trench', { category: 'outerwear', aiDescription: 'trench coat' })
    seed('bob', 'bob-trench', { category: 'outerwear', aiDescription: 'trench coat' })
    expect(ids(searchItems('trenchcoat', 'alice'))).toEqual(['alice-trench'])
    expect(ids(searchItems('outerwear', 'bob'))).toEqual(['bob-trench'])
    expect(() => searchItems('trench', '')).toThrow(/userId is required/)
  })
})
