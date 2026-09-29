import { describe, it, expect } from 'vitest'
import { itemMatchesSearch, outfitMatchesSearch, parseColors } from '../../src/lib/search'
import type { Item } from '../../src/api/items'
import type { HydratedOutfit } from '../../src/api/outfits'

const baseItem: Item = {
  id: 'i1',
  imageUri: 'images/items/a.jpg',
  category: 'tops',
  subcategory: 't-shirt',
  primaryColor: 'navy',
  colors: '["navy"]',
  material: 'linen',
  materialSource: null,
  careInstructions: '["machine wash cold"]',
  brand: 'Nike',
  size: 'M',
  season: '["summer"]',
  tags: '["favorite"]',
  aiDescription: 'A crisp white tee',
  wearContext: null,
  occasion: '["casual"]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  tagImageUri: null,
}

function item(overrides: Partial<Item> = {}): Item {
  return { ...baseItem, ...overrides }
}

function outfit(overrides: Partial<HydratedOutfit> = {}, items: Item[] = []): HydratedOutfit {
  return {
    id: 'o1',
    name: 'Saturday Brunch',
    itemIds: '[]',
    occasion: 'brunch',
    season: '["winter"]',
    tags: '["cozy"]',
    aiGenerated: 0,
    weatherContext: null,
    notes: 'warm and comfy',
    coverImageUri: null,
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now(),
    items,
    ...overrides,
  }
}

// An outfit whose own card fields match nothing — only its nested item can.
const quietOutfitFields: Partial<HydratedOutfit> = {
  name: 'Plain',
  occasion: null,
  season: '[]',
  tags: '[]',
  notes: null,
  aiGenerated: 0,
}

describe('parseColors', () => {
  it('parses the colors JSON array', () => {
    expect(parseColors(item({ colors: '["navy","cream"]' }))).toEqual(['navy', 'cream'])
  })

  it('returns [] for malformed JSON', () => {
    expect(parseColors(item({ colors: 'not json' }))).toEqual([])
  })

  it('returns [] for empty input', () => {
    expect(parseColors(item({ colors: '' }))).toEqual([])
  })
})

describe('itemMatchesSearch', () => {
  it('matches category', () => {
    expect(itemMatchesSearch(baseItem, 'tops')).toBe(true)
  })

  it('matches subcategory', () => {
    expect(itemMatchesSearch(baseItem, 't-shirt')).toBe(true)
  })

  it('matches brand', () => {
    expect(itemMatchesSearch(baseItem, 'nike')).toBe(true)
  })

  it('matches aiDescription', () => {
    expect(itemMatchesSearch(baseItem, 'crisp')).toBe(true)
  })

  it('matches an entry in the colors JSON array', () => {
    expect(itemMatchesSearch(baseItem, 'navy')).toBe(true)
  })

  it('matches an entry in the occasion JSON array', () => {
    expect(itemMatchesSearch(baseItem, 'casual')).toBe(true)
  })

  it('matches an entry in the tags JSON array', () => {
    expect(itemMatchesSearch(baseItem, 'favorite')).toBe(true)
  })

  it('matches an entry in the careInstructions JSON array', () => {
    expect(itemMatchesSearch(baseItem, 'machine wash')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(itemMatchesSearch(baseItem, 'NIKE')).toBe(true)
    expect(itemMatchesSearch(item({ brand: 'NIKE' }), 'nike')).toBe(true)
  })

  it('does not match primaryColor when the colors array is empty', () => {
    const i = item({ primaryColor: 'navy', colors: '[]' })
    expect(itemMatchesSearch(i, 'navy')).toBe(false)
  })

  it('does not match material or size or season — not part of Closet search', () => {
    expect(itemMatchesSearch(item({ brand: null, careInstructions: '[]' }), 'linen')).toBe(false)
    expect(itemMatchesSearch(baseItem, 'medium')).toBe(false)
    expect(itemMatchesSearch(baseItem, 'summer')).toBe(false)
  })

  it('tolerates malformed JSON array fields', () => {
    const i = item({ colors: 'oops', occasion: 'oops', tags: 'oops', careInstructions: 'oops' })
    expect(itemMatchesSearch(i, 'navy')).toBe(false)
    expect(() => itemMatchesSearch(i, 'anything')).not.toThrow()
  })

  it('matches everything on empty or whitespace-only query', () => {
    expect(itemMatchesSearch(baseItem, '')).toBe(true)
    expect(itemMatchesSearch(baseItem, '   ')).toBe(true)
  })
})

describe('outfitMatchesSearch', () => {
  it('matches name', () => {
    expect(outfitMatchesSearch(outfit(), 'saturday brunch')).toBe(true)
  })

  it('matches notes', () => {
    expect(outfitMatchesSearch(outfit(), 'comfy')).toBe(true)
  })

  it('matches occasion', () => {
    expect(outfitMatchesSearch(outfit(), 'brunch')).toBe(true)
  })

  it('matches an entry in the season JSON array', () => {
    expect(outfitMatchesSearch(outfit(), 'winter')).toBe(true)
  })

  it('matches an entry in the tags JSON array', () => {
    expect(outfitMatchesSearch(outfit(), 'cozy')).toBe(true)
  })

  it('matches "ai" only when the outfit carries the AI badge', () => {
    expect(outfitMatchesSearch(outfit({ aiGenerated: 1 }), 'ai')).toBe(true)
    expect(outfitMatchesSearch(outfit({ aiGenerated: 0 }), 'ai')).toBe(false)
  })

  it('matches a hydrated item through the Closet field set', () => {
    const o = outfit(quietOutfitFields, [baseItem])
    expect(outfitMatchesSearch(o, 'nike')).toBe(true)
    expect(outfitMatchesSearch(o, 'tops')).toBe(true)
    expect(outfitMatchesSearch(o, 'casual')).toBe(true)
    expect(outfitMatchesSearch(o, 'favorite')).toBe(true)
    expect(outfitMatchesSearch(o, 'machine wash')).toBe(true)
  })

  it('matches a hydrated item color, material and primaryColor', () => {
    const o = outfit(quietOutfitFields, [baseItem])
    expect(outfitMatchesSearch(o, 'navy')).toBe(true)
    expect(outfitMatchesSearch(o, 'linen')).toBe(true)
    expect(outfitMatchesSearch(o, 'crisp')).toBe(true)
  })

  it('matches when only a nested item matches — no outfit field does', () => {
    const o = outfit(quietOutfitFields, [item({ brand: 'Uniqlo' })])
    expect(outfitMatchesSearch(o, 'uniqlo')).toBe(true)
    expect(outfitMatchesSearch(outfit(quietOutfitFields, []), 'uniqlo')).toBe(false)
  })

  it('checks every hydrated item, not just the first', () => {
    const o = outfit(quietOutfitFields, [item({ brand: 'Nike' }), item({ id: 'i2', brand: 'Uniqlo' })])
    expect(outfitMatchesSearch(o, 'uniqlo')).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(outfitMatchesSearch(outfit(quietOutfitFields, [baseItem]), 'leather biker')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(outfitMatchesSearch(outfit(), 'WINTER')).toBe(true)
    expect(outfitMatchesSearch(outfit(), 'BRUNCH')).toBe(true)
  })

  it('tolerates malformed season/tags JSON', () => {
    const o = outfit({ season: 'not json', tags: 'not json' })
    expect(() => outfitMatchesSearch(o, 'winter')).not.toThrow()
    expect(outfitMatchesSearch(o, 'winter')).toBe(false)
  })

  it('matches everything on empty or whitespace-only query', () => {
    expect(outfitMatchesSearch(outfit(), '')).toBe(true)
    expect(outfitMatchesSearch(outfit(), '   ')).toBe(true)
  })
})
