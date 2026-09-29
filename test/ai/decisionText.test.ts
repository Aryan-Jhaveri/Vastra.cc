import { describe, it, expect } from 'vitest'
import { itemDecisionBlob, outfitDecisionBlob, DECISION_DESCRIPTION_MAX_CHARS } from '../../src/ai/decisionText.js'
import type { Item, Outfit } from '../../src/types/index.js'

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item1', userId: 'u1', imageUri: 'images/items/a.jpg', tagImageUri: null,
    category: 'top', subcategory: 'button-down shirt', primaryColor: 'white',
    colors: '["white","light blue"]', material: 'cotton', careInstructions: '["machine wash cold"]',
    brand: 'Uniqlo', size: 'M', season: '["spring","fall"]', tags: '["oxford","collared"]',
    aiDescription: 'Crisp white oxford shirt with a button-down collar.', occasion: '["work"]',
    wearContext: 'tucked in', materialSource: null, timesWorn: 3, lastWornAt: null,
    createdAt: 1, updatedAt: 1,
    ...overrides,
  } as Item
}

function makeOutfit(overrides: Partial<Outfit> = {}): Outfit {
  return {
    id: 'o1', userId: 'u1', name: 'Office Monday', itemIds: '["item1","gone"]', occasion: 'work',
    season: '["fall"]', aiGenerated: 0, weatherContext: null, notes: 'private note',
    coverImageUri: null, tags: '["smart"]', timesWorn: 0, lastWornAt: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  } as Outfit
}

describe('itemDecisionBlob', () => {
  it('carries every item-card text field Jev can reason over', () => {
    expect(itemDecisionBlob(makeItem())).toEqual({
      category: 'top',
      subcategory: 'button-down shirt',
      primaryColor: 'white',
      colors: ['white', 'light blue'],
      material: 'cotton',
      brand: 'Uniqlo',
      season: ['spring', 'fall'],
      occasion: ['work'],
      tags: ['oxford', 'collared'],
      wearContext: 'tucked in',
      description: 'Crisp white oxford shirt with a button-down collar.',
    })
  })

  it('omits ids, size, care, wear counts and image paths', () => {
    const blob = itemDecisionBlob(makeItem()) as Record<string, unknown>
    for (const key of ['id', 'userId', 'size', 'careInstructions', 'timesWorn', 'imageUri', 'formality']) {
      expect(blob).not.toHaveProperty(key)
    }
  })

  it('drops null fields and empty or malformed JSON lists', () => {
    const blob = itemDecisionBlob(makeItem({
      subcategory: null, brand: null, aiDescription: '   ', wearContext: null,
      colors: '[]', tags: 'not json', occasion: '{"a":1}',
    }))
    expect(blob).toEqual({
      category: 'top', primaryColor: 'white', material: 'cotton', season: ['spring', 'fall'],
    })
  })

  it('caps long descriptions', () => {
    const blob = itemDecisionBlob(makeItem({ aiDescription: 'x'.repeat(1000) }))
    expect(blob.description).toHaveLength(DECISION_DESCRIPTION_MAX_CHARS)
    expect(blob.description!.endsWith('…')).toBe(true)
  })
})

describe('outfitDecisionBlob', () => {
  it('includes outfit labels and full item blobs, skipping deleted items and notes', () => {
    const blob = outfitDecisionBlob(makeOutfit(), new Map([['item1', makeItem()]]))
    expect(blob).toMatchObject({ name: 'Office Monday', occasion: 'work', season: ['fall'], tags: ['smart'] })
    expect(blob.items).toEqual([itemDecisionBlob(makeItem())])
    expect(blob).not.toHaveProperty('notes')
  })

  it('returns no items when every item was deleted', () => {
    expect(outfitDecisionBlob(makeOutfit(), new Map()).items).toEqual([])
  })
})
