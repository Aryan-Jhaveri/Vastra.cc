import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(), { status: 200 })))

vi.mock('../../src/api/client', () => ({ thumbUri: (uri: string) => uri }))

import { ItemCard } from '../../src/components/ItemCard'
import { SavedOutfitCard } from '../../src/components/SavedOutfitCard'
import { CollectionCard } from '../../src/components/CollectionCard'
import type { Item } from '../../src/api/items'
import type { HydratedOutfit } from '../../src/api/outfits'
import type { HydratedCollection } from '../../src/api/collections'

const baseItemFields = {
  userId: 'x',
  careInstructions: '[]',
  brand: null,
  size: null,
  material: null,
  materialSource: null,
  wearContext: null,
  aiDescription: null,
  timesWorn: 0,
  lastWornAt: null,
  tagImageUri: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

const mockItem: Item = {
  id: 'a',
  imageUri: 'images/items/a.jpg',
  category: 'tops',
  subcategory: 'T-Shirt',
  colors: '["blue"]',
  season: '[]',
  tags: '[]',
  occasion: '[]',
  primaryColor: 'blue',
  ...baseItemFields,
}

const mockOutfit: HydratedOutfit = {
  id: 'a',
  userId: 'x',
  name: 'Casual',
  coverImageUri: null,
  occasion: null,
  season: '[]',
  tags: '[]',
  notes: null,
  aiGenerated: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  items: [{
    id: 'i1',
    userId: 'x',
    imageUri: 'images/items/x.jpg',
    category: 'tops',
    subcategory: 'T-Shirt',
    colors: '[]',
    season: '[]',
    tags: '[]',
    occasion: '[]',
    primaryColor: null,
    brand: null,
    size: null,
    material: null,
    materialSource: null,
    wearContext: null,
    aiDescription: null,
    careInstructions: '[]',
    timesWorn: 0,
    lastWornAt: null,
    tagImageUri: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }],
  aiMetadata: null,
}

const mockCollection: HydratedCollection = {
  id: 'a',
  userId: 'x',
  name: 'Summer',
  coverImageUri: null,
  tags: '[]',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  outfits: [],
}

describe('Card metadata strip consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  it('ItemCard renders metadata strip regardless of fields', () => {
    const { container } = render(<ItemCard item={mockItem} />)
    expect(container.querySelector('.min-h-\\[3rem\\]')).toBeTruthy()
  })

  it('ItemCard still renders meta when colors empty', () => {
    const noColors: Item = { ...mockItem, colors: '[]' }
    const { container } = render(<ItemCard item={noColors} />)
    expect(container.querySelector('.min-h-\\[3rem\\]')).toBeTruthy()
    expect(container.textContent).toContain('T-Shirt')
  })

  it('SavedOutfitCard renders consistently without occasion/tags', () => {
    const { container } = render(<SavedOutfitCard outfit={mockOutfit} />)
    expect(container.textContent).toContain('Casual')
  })

  it('SavedOutfitCard renders consistently with occasion and tags filled', () => {
    const filled: HydratedOutfit = {
      ...mockOutfit,
      occasion: 'casual',
      season: '["summer"]',
      tags: '["weekend"]',
    }
    const { container } = render(<SavedOutfitCard outfit={filled} />)
    expect(container.textContent).toContain('Casual')
  })

  it('CollectionCard renders consistently', () => {
    const { container } = render(<CollectionCard collection={mockCollection} />)
    expect(container.textContent).toContain('Summer')
    expect(container.textContent).toContain('0 outfits')
  })

  it('ItemCard applies marching ants animation when selected in select mode', () => {
    const { container } = render(<ItemCard item={mockItem} selectable selected />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('animate-border-march')
  })

  it('ItemCard applies hover token when not selected', () => {
    const { container } = render(<ItemCard item={mockItem} />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('hover:bg-surface-dim')
    expect(button?.className).toContain('bg-paper')
  })

  it('SavedOutfitCard applies marching ants when selected in select mode', () => {
    const { container } = render(<SavedOutfitCard outfit={mockOutfit} selectable selected />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('animate-border-march')
  })
})
