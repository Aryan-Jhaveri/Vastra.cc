import { describe, it, expect } from 'vitest'
import { applyItemFilters, type ItemFilterState } from '../../src/components/ItemFilterControls'
import type { Item } from '../../src/api/items'

const baseItem: Item = {
  id: 'i1',
  imageUri: 'images/items/a.jpg',
  category: 'tops',
  subcategory: 'shirt',
  primaryColor: 'navy',
  colors: '["navy","cream"]',
  material: 'cotton',
  materialSource: null,
  careInstructions: '[]',
  brand: 'Nike',
  size: 'M',
  season: '["summer"]',
  tags: '[]',
  aiDescription: null,
  wearContext: null,
  occasion: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  tagImageUri: null,
}

const emptyFilters: ItemFilterState = {
  categories: [],
  search: '',
  color: '',
  season: '',
  occasion: '',
  brand: '',
  types: [],
  material: '',
  tags: [],
}

describe('applyItemFilters', () => {
  it('returns item when no filters set', () => {
    expect(applyItemFilters([baseItem], emptyFilters)).toHaveLength(1)
  })

  it('finds item by primary color (first entry in colors)', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, color: 'navy' })
    expect(result).toHaveLength(1)
  })

  it('finds item by secondary color (not primaryColor)', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, color: 'cream' })
    expect(result).toHaveLength(1)
  })

  it('excludes item when color filter does not match any color', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, color: 'red' })
    expect(result).toHaveLength(0)
  })

  it('search matches on colors array entry', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, search: 'cream' })
    expect(result).toHaveLength(1)
  })

  it('search matches on category', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, search: 'tops' })
    expect(result).toHaveLength(1)
  })

  it('search matches on subcategory', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, search: 'shirt' })
    expect(result).toHaveLength(1)
  })

  it('search matches on brand', () => {
    const result = applyItemFilters([baseItem], { ...emptyFilters, search: 'nike' })
    expect(result).toHaveLength(1)
  })

  it('search matches on aiDescription', () => {
    const item = { ...baseItem, aiDescription: 'A crisp linen shirt' }
    const result = applyItemFilters([item], { ...emptyFilters, search: 'linen' })
    expect(result).toHaveLength(1)
  })

  it('search matches on the occasion JSON array', () => {
    const item = { ...baseItem, occasion: '["work","date night"]' }
    const result = applyItemFilters([item], { ...emptyFilters, search: 'date' })
    expect(result).toHaveLength(1)
  })

  it('search matches on the tags JSON array', () => {
    const item = { ...baseItem, tags: '["favorite"]' }
    const result = applyItemFilters([item], { ...emptyFilters, search: 'favorite' })
    expect(result).toHaveLength(1)
  })

  it('search matches on the careInstructions JSON array', () => {
    const item = { ...baseItem, careInstructions: '["machine wash cold"]' }
    const result = applyItemFilters([item], { ...emptyFilters, search: 'machine wash' })
    expect(result).toHaveLength(1)
  })

  it('search ignores primaryColor when the colors array does not match', () => {
    const item = { ...baseItem, primaryColor: 'red', colors: '["navy"]' }
    expect(applyItemFilters([item], { ...emptyFilters, search: 'red' })).toHaveLength(0)
    expect(applyItemFilters([item], { ...emptyFilters, search: 'navy' })).toHaveLength(1)
  })

  it('search is case-insensitive and trims whitespace', () => {
    expect(applyItemFilters([baseItem], { ...emptyFilters, search: 'NIKE' })).toHaveLength(1)
    expect(applyItemFilters([baseItem], { ...emptyFilters, search: '  nike  ' })).toHaveLength(1)
  })

  it('combines search with the color filter — both must match', () => {
    const other = { ...baseItem, id: 'i2', colors: '["cream"]', brand: 'Nike' }
    const result = applyItemFilters([baseItem, other], { ...emptyFilters, color: 'navy', search: 'nike' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('i1')
  })

  it('finds item by tag exact match', () => {
    const item = { ...baseItem, tags: '["formal"]' }
    const result = applyItemFilters([item], { ...emptyFilters, tags: ['formal'] })
    expect(result).toHaveLength(1)
  })

  it('excludes item when tag filter does not match', () => {
    const item = { ...baseItem, tags: '["casual"]' }
    const result = applyItemFilters([item], { ...emptyFilters, tags: ['formal'] })
    expect(result).toHaveLength(0)
  })

  it('matches tag case-insensitively (stored uppercase, filter lowercase)', () => {
    const item = { ...baseItem, tags: '["FORMAL"]' }
    const result = applyItemFilters([item], { ...emptyFilters, tags: ['formal'] })
    expect(result).toHaveLength(1)
  })

  it('matches tag case-insensitively (stored lowercase, filter uppercase)', () => {
    const item = { ...baseItem, tags: '["formal"]' }
    const result = applyItemFilters([item], { ...emptyFilters, tags: ['FORMAL'] })
    expect(result).toHaveLength(1)
  })

  it('finds item by occasion exact match', () => {
    const item = { ...baseItem, occasion: '["formal"]' }
    const result = applyItemFilters([item], { ...emptyFilters, occasion: 'formal' })
    expect(result).toHaveLength(1)
  })

  it('excludes item when occasion filter does not match', () => {
    const item = { ...baseItem, occasion: '["casual"]' }
    const result = applyItemFilters([item], { ...emptyFilters, occasion: 'formal' })
    expect(result).toHaveLength(0)
  })

  it('matches occasion case-insensitively (stored uppercase, filter lowercase)', () => {
    const item = { ...baseItem, occasion: '["FORMAL"]' }
    const result = applyItemFilters([item], { ...emptyFilters, occasion: 'formal' })
    expect(result).toHaveLength(1)
  })

  it('matches occasion case-insensitively (stored lowercase, filter uppercase)', () => {
    const item = { ...baseItem, occasion: '["formal"]' }
    const result = applyItemFilters([item], { ...emptyFilters, occasion: 'FORMAL' })
    expect(result).toHaveLength(1)
  })
})

import { describe as describeRender, it as itRender, expect as expectRender, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { ItemFilterControls as ItemFilterControlsComponent } from '../../src/components/ItemFilterControls'
import type { Item } from '../../src/api/items'

vi.stubGlobal('IntersectionObserver', undefined)

const itemsWithTagsAndTypes: Item[] = [
  { ...baseItem, tags: '["casual","active"]', subcategory: 'T-Shirt' },
  { ...baseItem, tags: '["formal"]', subcategory: 'Shirt' },
  { ...baseItem, tags: '["casual"]', subcategory: 'Hoodie' },
]

describeRender('ItemFilterControls — chip panel margins', () => {
  itRender('open Tags panel has mt-1 mb-3, closed has mt-0', () => {
    render(
      <ItemFilterControlsComponent
        allItems={itemsWithTagsAndTypes}
        value={emptyFilters}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )

    expect(screen.getByText('Tags')).toBeTruthy()
    expect(screen.getByText('Type')).toBeTruthy()

    fireEvent.click(screen.getByText('Tags'))

    // Tags opened first → firstOpened='tags' → tags section is index 0
    const tagsPanel = document.querySelectorAll('div[class*="grid transition-all"]')[0]
    expect(tagsPanel.className).toContain('mt-1')
    expect(tagsPanel.className).toContain('mb-3')
    expect(tagsPanel.className).not.toContain('mt-0')

    fireEvent.click(screen.getByText('Tags'))

    // Both closed → compact mode, grid panels are unmounted
    expect(document.querySelectorAll('div[class*="grid transition-all"]').length).toBe(0)
  })

  itRender('open Type panel has mt-0 mb-3, closed has mt-0', () => {
    render(
      <ItemFilterControlsComponent
        allItems={itemsWithTagsAndTypes}
        value={emptyFilters}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Type'))

    // Type opened first → firstOpened='types' → types section rendered first (index 0)
    const panels = document.querySelectorAll('div[class*="grid transition-all"]')
    const typePanel = panels[0]
    expect(typePanel.className).toContain('mt-1')
    expect(typePanel.className).toContain('mb-3')

    fireEvent.click(screen.getByText('Type'))

    // Both closed → compact mode, grid panels are unmounted
    expect(document.querySelectorAll('div[class*="grid transition-all"]').length).toBe(0)
  })

  itRender('Tags and Type panel both have spacing when open', () => {
    render(
      <ItemFilterControlsComponent
        allItems={itemsWithTagsAndTypes}
        value={emptyFilters}
        onChange={() => {}}
        onClear={() => {}}
      />,
    )

    // Open Tags first: tags at index 0
    fireEvent.click(screen.getByText('Tags'))
    const tagsPanel = document.querySelectorAll('div[class*="grid transition-all"]')[0]
    expect(tagsPanel.className).toContain('mt-1')
    expect(tagsPanel.className).toContain('mb-3')
    fireEvent.click(screen.getByText('Tags'))

    // Now open Type: firstOpened resets to 'types', types at index 0
    fireEvent.click(screen.getByText('Type'))
    const typePanel = document.querySelectorAll('div[class*="grid transition-all"]')[0]
    expect(typePanel.className).toContain('mt-1')
    expect(typePanel.className).toContain('mb-3')
  })
})