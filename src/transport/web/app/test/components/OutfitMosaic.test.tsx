import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { OutfitMosaic } from '../../src/components/OutfitMosaic'
import type { Item } from '../../src/api/items'

function mosaicItem(id: string): Item {
  return {
    id,
    imageUri: `images/items/${id}.jpg`,
    category: 'tops',
    subcategory: 't-shirt',
    primaryColor: 'navy',
    colors: '[]',
    material: null,
    materialSource: null,
    careInstructions: '[]',
    brand: null,
    size: null,
    season: '[]',
    tags: '[]',
    aiDescription: null,
    wearContext: null,
    occasion: '[]',
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now(),
    tagImageUri: null,
  }
}

function imgSources(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('img'))
    .map(img => img.getAttribute('data-src') ?? '')
}

describe('OutfitMosaic', () => {
  it('renders the first four item photos', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map(mosaicItem)
    const { container } = render(<OutfitMosaic items={items} />)
    expect(imgSources(container)).toEqual([
      '/images/items/a.jpg',
      '/images/items/b.jpg',
      '/images/items/c.jpg',
      '/images/items/d.jpg',
    ])
  })

  it('pads to four cells when fewer than four items', () => {
    const { container } = render(<OutfitMosaic items={[mosaicItem('a'), mosaicItem('b')]} />)
    expect(imgSources(container)).toEqual(['/images/items/a.jpg', '/images/items/b.jpg'])
    const cells = container.querySelectorAll('.grid > div')
    expect(cells.length).toBe(4)
    expect(cells[2].className).toContain('bg-surface')
    expect(cells[3].className).toContain('bg-surface')
  })

  it('renders four empty cells for an empty outfit', () => {
    const { container } = render(<OutfitMosaic items={[]} />)
    expect(container.querySelectorAll('img').length).toBe(0)
    expect(container.querySelectorAll('.grid > div').length).toBe(4)
  })

  it('uses the 2×2 grid layout shared with SavedOutfitCard', () => {
    const { container } = render(<OutfitMosaic items={[mosaicItem('a')]} />)
    expect(container.firstChild).toHaveClass('grid', 'grid-cols-2')
  })
})
