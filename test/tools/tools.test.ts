import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import sharp from 'sharp'

const TEST_DIR = process.env.CLOSET_DATA_DIR!
const U = 'self'

async function makeTempJpeg(): Promise<string> {
  mkdirSync(TEST_DIR, { recursive: true })
  const path = join(TEST_DIR, `src_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)
  await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 80, g: 120, b: 200 } },
  }).jpeg().toFile(path)
  return path
}

const { addItem, listItems, getItem, updateItem, deleteItem, searchItems, markWorn } =
  await import('../../src/tools/items.js')
const { createOutfit, listOutfits, getOutfit, markOutfitWorn, deleteOutfit, updateOutfit } =
  await import('../../src/tools/outfits.js')
const { addUserPhoto, listUserPhotos, setPrimaryPhoto } =
  await import('../../src/tools/photos.js')

import { db } from '../../src/db/client.js'
import { UpdateItemInputSchema } from '../../src/types/index.js'
import { items, outfits, userPhotos } from '../../src/db/schema.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  for (const sub of ['items', 'tags', 'tryon', 'user', 'outfits']) {
    mkdirSync(join(TEST_DIR, 'images', sub), { recursive: true })
  }
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(userPhotos).run()
  db.delete(outfits).run()
  db.delete(items).run()
})

// ─── Items ────────────────────────────────────────────────────────────────────

describe('addItem', () => {
  it('saves an item from a file path', async () => {
    const src = await makeTempJpeg()
    const { item } = await addItem({ imagePath: src, category: 'tops', primaryColor: 'black' }, U)
    expect(item.id).toBeDefined()
    expect(item.category).toBe('tops')
    expect(item.primaryColor).toBe('black')
    expect(item.imageUri).toMatch(/^images\/items\/.+\.jpg$/)
  })

  it('throws without an image source', async () => {
    await expect(addItem({ category: 'tops' }, U)).rejects.toThrow()
  })

  it('normalizes occasion array on add: trims, lowercases, and dedupes', async () => {
    const src = await makeTempJpeg()
    const { item } = await addItem({
      imagePath: src,
      category: 'tops',
      occasion: ['Formal', 'FORMAL', '  formal  ', 'Casual'],
    }, U)
    expect(item.occasion).toBe(JSON.stringify(['formal', 'casual']))
  })
})

describe('listItems', () => {
  it('returns all items when no filter', async () => {
    const src = await makeTempJpeg()
    await addItem({ imagePath: src, category: 'tops' }, U)
    await addItem({ imagePath: await makeTempJpeg(), category: 'shoes' }, U)
    const all = await listItems({}, U)
    expect(all.length).toBe(2)
  })

  it('filters by category', async () => {
    await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    await addItem({ imagePath: await makeTempJpeg(), category: 'shoes' }, U)
    const tops = await listItems({ category: 'tops' }, U)
    expect(tops.length).toBe(1)
    expect(tops[0].category).toBe('tops')
  })

  it('filters by color', async () => {
    await addItem({ imagePath: await makeTempJpeg(), category: 'tops', colors: ['navy', 'white'] }, U)
    await addItem({ imagePath: await makeTempJpeg(), category: 'tops', colors: ['red'] }, U)
    const results = await listItems({ color: 'navy' }, U)
    expect(results.length).toBe(1)
  })

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    }
    const results = await listItems({ limit: 3 }, U)
    expect(results.length).toBe(3)
  })
})

describe('getItem', () => {
  it('returns item by id', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    const found = await getItem(item.id, U)
    expect(found?.id).toBe(item.id)
  })

  it('returns null for unknown id', async () => {
    expect(await getItem('nonexistent', U)).toBeNull()
  })
})

describe('updateItem', () => {
  it('updates item fields', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    const updated = await updateItem(item.id, { brand: 'Levi\'s', tags: ['casual', 'denim'] }, U)
    expect(updated.brand).toBe('Levi\'s')
    expect(updated.tags).toBe(JSON.stringify(['casual', 'denim']))
  })

  it('normalizes tags: trims, lowercases, and dedupes', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    const updated = await updateItem(item.id, { tags: ['Formal', 'FORMAL', '  formal  ', 'Casual'] }, U)
    expect(updated.tags).toBe(JSON.stringify(['formal', 'casual']))
  })

  it('normalizes occasion array: trims, lowercases, and dedupes', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    const updated = await updateItem(item.id, { occasion: ['Work', 'WORK', '  work  ', 'Casual'] }, U)
    expect(updated.occasion).toBe(JSON.stringify(['work', 'casual']))
  })

  it('clears text fields sent as null (ItemDetail backspace-and-save)', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    await updateItem(item.id, { brand: 'Uniqlo', material: 'cotton', size: 'M', subcategory: 'tee', primaryColor: 'Navy' }, U)
    const cleared = { brand: null, material: null, size: null, subcategory: null, primaryColor: null, aiDescription: null }
    // The PATCH route validates with this schema before calling updateItem.
    expect(UpdateItemInputSchema.omit({ id: true }).safeParse(cleared).success).toBe(true)
    const updated = await updateItem(item.id, cleared, U)
    expect(updated).toMatchObject(cleared)
  })
})

describe('deleteItem', () => {
  it('removes item from db', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    await deleteItem(item.id, U)
    expect(await getItem(item.id, U)).toBeNull()
  })
})

describe('searchItems', () => {
  it('finds items by description or tag', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops', tags: ['vintage'] }, U)
    await updateItem(item.id, { aiDescription: 'A slim-fit vintage denim jacket' }, U)
    const results = await searchItems('vintage', U)
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})

describe('markWorn', () => {
  it('increments timesWorn and sets lastWornAt', async () => {
    const { item } = await addItem({ imagePath: await makeTempJpeg(), category: 'tops' }, U)
    const worn = await markWorn(item.id, U)
    expect(worn.timesWorn).toBe(1)
    expect(worn.lastWornAt).toBeDefined()
    const worn2 = await markWorn(item.id, U)
    expect(worn2.timesWorn).toBe(2)
  })
})

// ─── Outfits ──────────────────────────────────────────────────────────────────

// Outfits may only reference the owner's items, so seed the fixture ids.
function seedItems(userId: string, ids: string[]) {
  const now = Date.now()
  for (const id of ids) {
    db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: now, updatedAt: now }).run()
  }
}

describe('outfits', () => {
  beforeEach(() => seedItems(U, ['a', 'b', 'x']))

  describe('createOutfit', () => {
    it('creates an outfit', async () => {
      const outfit = await createOutfit({ name: 'Weekend Look', itemIds: ['a', 'b'], occasion: 'casual' }, U)
      expect(outfit.name).toBe('Weekend Look')
      expect(outfit.occasion).toBe('casual')
      expect(JSON.parse(outfit.itemIds)).toEqual(['a', 'b'])
    })

    it('normalizes tags: trims, lowercases, and dedupes', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'], tags: ['Formal', 'FORMAL', '  formal  ', 'Casual'] }, U)
      expect(outfit.tags).toBe(JSON.stringify(['formal', 'casual']))
    })

    it('normalizes occasion string: trims + lowercases', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'], occasion: '  FORMAL  ' }, U)
      expect(outfit.occasion).toBe('formal')
    })

    it('treats empty/whitespace occasion as undefined', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'], occasion: '   ' }, U)
      expect(outfit.occasion ?? null).toBeNull()
    })
  })

  describe('updateOutfit', () => {
    it('normalizes tags on update', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'] }, U)
      const updated = await updateOutfit(outfit.id, { tags: ['Formal', 'FORMAL', '  formal  ', 'Casual'] }, U)
      expect(updated.tags).toBe(JSON.stringify(['formal', 'casual']))
    })

    it('normalizes occasion on update: trims + lowercases', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'], occasion: 'casual' }, U)
      const updated = await updateOutfit(outfit.id, { occasion: '  FORMAL  ' }, U)
      expect(updated.occasion).toBe('formal')
    })

    it('treats empty occasion as NULL on update', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['a'], occasion: 'formal' }, U)
      const updated = await updateOutfit(outfit.id, { occasion: '   ' }, U)
      expect(updated.occasion).toBeNull()
    })
  })

  describe('listOutfits', () => {
    it('filters by occasion', async () => {
      await createOutfit({ name: 'Casual', itemIds: ['a'], occasion: 'casual' }, U)
      await createOutfit({ name: 'Work', itemIds: ['b'], occasion: 'work' }, U)
      const results = await listOutfits({ occasion: 'casual' }, U)
      expect(results.length).toBe(1)
      expect(results[0].name).toBe('Casual')
    })
  })

  describe('markOutfitWorn', () => {
    it('increments timesWorn', async () => {
      const outfit = await createOutfit({ name: 'Test', itemIds: ['x'] }, U)
      const worn = await markOutfitWorn(outfit.id, U)
      expect(worn.timesWorn).toBe(1)
    })
  })

  describe('deleteOutfit', () => {
    it('removes outfit', async () => {
      const outfit = await createOutfit({ name: 'Temp', itemIds: ['x'] }, U)
      await deleteOutfit(outfit.id, U)
      expect(await getOutfit(outfit.id, U)).toBeNull()
    })
  })

  describe('outfit item ownership', () => {
    const OTHER = 'user_outfit_other'

    it('createOutfit rejects another user\'s item ids', async () => {
      seedItems(OTHER, ['foreign1'])
      await expect(createOutfit({ name: 'Steal', itemIds: ['a', 'foreign1'] }, U)).rejects.toThrow(/Unknown item ids: foreign1/)
      expect(await listOutfits({}, U)).toHaveLength(0)
    })

    it('createOutfit rejects nonexistent item ids', async () => {
      await expect(createOutfit({ name: 'Ghost', itemIds: ['nope'] }, U)).rejects.toThrow(/Unknown item ids/)
    })

    it('updateOutfit rejects another user\'s item ids and leaves the outfit unchanged', async () => {
      seedItems(OTHER, ['foreign2'])
      const outfit = await createOutfit({ name: 'Mine', itemIds: ['a'] }, U)
      await expect(updateOutfit(outfit.id, { itemIds: ['foreign2'] }, U)).rejects.toThrow(/Unknown item ids/)
      expect(JSON.parse((await getOutfit(outfit.id, U))!.itemIds)).toEqual(['a'])
    })
  })
})

// ─── User Photos ──────────────────────────────────────────────────────────────

describe('addUserPhoto', () => {
  it('saves a user photo', async () => {
    const src = await makeTempJpeg()
    const photo = await addUserPhoto({ imagePath: src, label: 'Front view' }, U)
    expect(photo.label).toBe('Front view')
    expect(photo.imageUri).toMatch(/^images\/user\/.+\.jpg$/)
  })
})

describe('setPrimaryPhoto', () => {
  it('sets one photo as primary', async () => {
    const p1 = await addUserPhoto({ imagePath: await makeTempJpeg() }, U)
    const p2 = await addUserPhoto({ imagePath: await makeTempJpeg() }, U)
    await setPrimaryPhoto(p2.id, U)
    const photos = await listUserPhotos(U)
    const primary = photos.find(p => p.isPrimary === 1)
    expect(primary?.id).toBe(p2.id)
  })
})
