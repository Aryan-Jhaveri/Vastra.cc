import { describe, it, expect } from 'vitest'
import { buildItemPayload, buildClassificationPatch, applyClassificationToItem, type ReviewItem } from '../../src/modals/AddItemFlow'
import type { ItemClassification } from '../../src/api/items'

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: '1',
    photoIdx: 0,
    box: { x: 0, y: 0, w: 20, h: 20 },
    category: 'tops',
    cropColor: '#d4e8d4',
    croppedFile: null,
    croppedPreview: null,
    classification: null,
    classifying: false,
    classifyError: false,
    decision: 'pending',
    saveKey: 'test-save-key-0001',
    createdItemId: null,
    createdImageUri: null,
    editCategory: 'tops',
    editSubcategory: '',
    editColors: [],
    editBrand: '',
    editSize: '',
    editSeason: '',
    editDescription: '',
    ...overrides,
  }
}

function makeClassification(overrides: Partial<ItemClassification> = {}): ItemClassification {
  return {
    category: 'tops',
    subcategory: 't-shirt',
    primary_color: 'blue',
    colors: ['blue', 'white'],
    material: 'cotton',
    season: ['summer'],
    ai_description: 'A classic blue cotton t-shirt',
    suggested_tags: ['casual'],
    wear_context: null,
    ...overrides,
  }
}

describe('buildItemPayload', () => {
  it('falls back to classification.ai_description when editDescription is empty', () => {
    const cls: ItemClassification = {
      category: 'tops',
      subcategory: 't-shirt',
      primary_color: 'blue',
      colors: ['blue', 'white'],
      material: 'cotton',
      season: ['summer'],
      ai_description: 'A classic blue cotton t-shirt',
      suggested_tags: ['casual'],
      wear_context: null,
    }
    const item = makeReviewItem({ editDescription: '', classification: cls })
    expect(buildItemPayload(item).aiDescription).toBe('A classic blue cotton t-shirt')
  })

  it('prefers editDescription over classification.ai_description', () => {
    const cls: ItemClassification = {
      category: 'tops',
      subcategory: 't-shirt',
      primary_color: 'blue',
      colors: ['blue', 'white'],
      material: 'cotton',
      season: ['summer'],
      ai_description: 'AI-generated description',
      suggested_tags: ['casual'],
      wear_context: null,
    }
    const item = makeReviewItem({ editDescription: 'My custom description', classification: cls })
    expect(buildItemPayload(item).aiDescription).toBe('My custom description')
  })

  it('returns undefined aiDescription when both are empty', () => {
    const item = makeReviewItem({ editDescription: '', classification: null })
    expect(buildItemPayload(item).aiDescription).toBeUndefined()
  })

  it('includes editDescription=undefined when both edit and classification are absent', () => {
    const item = makeReviewItem()
    expect(buildItemPayload(item).aiDescription).toBeUndefined()
  })
})

describe('buildClassificationPatch', () => {
  it('returns classification-derived fields (no category, brand, size)', () => {
    const cls = makeClassification()
    const item = makeReviewItem({ classification: cls })
    const patch = buildClassificationPatch(item)
    expect(patch.subcategory).toBe('t-shirt')
    expect(patch.primaryColor).toBe('blue')
    expect(patch.aiDescription).toBe('A classic blue cotton t-shirt')
    expect(patch.material).toBe('cotton')
    expect(patch.wearContext).toBeUndefined()
    expect(patch.tags).toEqual(['casual'])
    expect(patch.colors).toEqual(['blue', 'white'])
    expect(patch.season).toEqual(['summer'])
    // Must NOT include category, brand, size
    expect(patch).not.toHaveProperty('category')
    expect(patch).not.toHaveProperty('brand')
    expect(patch).not.toHaveProperty('size')
  })

  it('prefers edit fields over classification', () => {
    const cls = makeClassification({ subcategory: 't-shirt', primary_color: 'blue', ai_description: 'AI desc' })
    const item = makeReviewItem({
      classification: cls,
      editSubcategory: 'polo',
      editColors: ['navy'],
      editSeason: 'winter',
      editDescription: 'My custom desc',
    })
    const patch = buildClassificationPatch(item)
    expect(patch.subcategory).toBe('polo')
    expect(patch.primaryColor).toBe('navy')
    expect(patch.season).toEqual(['winter'])
    expect(patch.aiDescription).toBe('My custom desc')
  })

  it('returns arrays, not JSON-stringified strings (regression: late-PATCH 500)', () => {
    const cls = makeClassification({
      colors: ['navy', 'white'],
      season: ['summer'],
      suggested_tags: ['casual'],
    })
    const item = makeReviewItem({ classification: cls })
    const patch = buildClassificationPatch(item)
    expect(Array.isArray(patch.colors)).toBe(true)
    expect(Array.isArray(patch.season)).toBe(true)
    expect(Array.isArray(patch.tags)).toBe(true)
    expect(typeof patch.colors).not.toBe('string')
    expect(typeof patch.season).not.toBe('string')
    expect(typeof patch.tags).not.toBe('string')
  })

  it('returns undefined subcategory/primaryColor when neither edit nor classification is set', () => {
    const item = makeReviewItem()
    const patch = buildClassificationPatch(item)
    expect(patch.subcategory).toBeUndefined()
    expect(patch.primaryColor).toBeUndefined()
    expect(patch.aiDescription).toBeUndefined()
  })

  it('buildItemPayload output equals { category, brand, size, ...buildClassificationPatch }', () => {
    const cls = makeClassification()
    const item = makeReviewItem({
      classification: cls,
      editBrand: 'Nike',
      editSize: 'M',
      editCategory: 'shoes',
    })
    const payload = buildItemPayload(item)
    const patch = buildClassificationPatch(item)
    expect(payload.category).toBe('shoes')
    expect(payload.brand).toBe('Nike')
    expect(payload.size).toBe('M')
    expect(payload.subcategory).toBe(patch.subcategory)
    expect(payload.primaryColor).toBe(patch.primaryColor)
    expect(payload.aiDescription).toBe(patch.aiDescription)
    expect(payload.material).toBe(patch.material)
    expect(payload.wearContext).toBe(patch.wearContext)
    expect(payload.tags).toBe(patch.tags)
    expect(payload.colors).toBe(patch.colors)
    expect(payload.season).toBe(patch.season)
  })
})

describe('applyClassificationToItem', () => {
  it('sets edit fields from classification when nothing has been edited', () => {
    const item = makeReviewItem()
    const cls = makeClassification({ category: 'bottoms', subcategory: 'jeans', primary_color: 'navy', season: ['fall'], ai_description: 'Navy jeans' })
    const result = applyClassificationToItem(item, cls)
    expect(result.editCategory).toBe('bottoms')
    expect(result.editSubcategory).toBe('jeans')
    expect(result.editColors).toEqual(['blue', 'white'])
    expect(result.editSeason).toBe('fall')
    expect(result.editDescription).toBe('Navy jeans')
    expect(result.classifying).toBe(false)
  })

  it('preserves user-edited category when classification returns different value', () => {
    const item = makeReviewItem({ editCategory: 'outerwear' })
    const cls = makeClassification({ category: 'tops' })
    const result = applyClassificationToItem(item, cls)
    expect(result.editCategory).toBe('outerwear')
  })

  it('preserves all user edits when any field has been changed', () => {
    const item = makeReviewItem({ editCategory: 'bottoms' })
    const cls = makeClassification({ subcategory: 't-shirt', primary_color: 'red', season: ['winter'], ai_description: 'A red t-shirt' })
    const result = applyClassificationToItem(item, cls)
    expect(result.editCategory).toBe('bottoms')
    expect(result.editSubcategory).toBe('')
    expect(result.editColors).toEqual([])
    expect(result.editSeason).toBe('')
    expect(result.editDescription).toBe('')
  })

  it('preserves edit on item 2 when item 2 has been edited before classification', () => {
    // Simulates the bug scenario: two items in review queue, user edits second one
    const item2 = makeReviewItem({
      id: 'item-2',
      category: 'bottoms',
      editCategory: 'shoes',
      editSubcategory: 'sneakers',
      editColors: ['white'],
    })
    const cls = makeClassification({ category: 'bottoms', subcategory: 'jeans', primary_color: 'navy' })
    const result = applyClassificationToItem(item2, cls)
    expect(result.editCategory).toBe('shoes')
    expect(result.editSubcategory).toBe('sneakers')
    expect(result.editColors).toEqual(['white'])
  })

  it('does NOT consider brand/size/season/description changes as edit if they were set by classification previously', () => {
    // When classification set editSubcategory but user only changed editCategory, the other fields should still accept new classification values
    // This is the "wasEdited" gate: if ANY field was edited, ALL fields are preserved.
    // This test documents the current conservative behavior (block all classification overwrites if any field edited).
    const item = makeReviewItem({ editCategory: 'shoes' })
    const cls = makeClassification({ subcategory: 'sneakers', primary_color: 'white', season: ['summer'], ai_description: 'White sneakers' })
    const result = applyClassificationToItem(item, cls)
    expect(result.editCategory).toBe('shoes')
    // Conservative: all fields blocked because editCategory was changed
    expect(result.editSubcategory).toBe('')
    expect(result.editColors).toEqual([])
    expect(result.editSeason).toBe('')
    expect(result.editDescription).toBe('')
  })

  it('sets classification and classifying:false on the returned update', () => {
    const item = makeReviewItem()
    const cls = makeClassification()
    const result = applyClassificationToItem(item, cls)
    expect(result.classification).toBe(cls)
    expect(result.classifying).toBe(false)
  })
})
