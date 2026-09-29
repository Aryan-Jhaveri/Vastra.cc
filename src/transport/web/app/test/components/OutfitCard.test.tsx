import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: (p: { alt?: string; src?: string }) => <img alt={p.alt} src={p.src} />,
}))
vi.mock('../../src/components/ShareButton', () => ({
  ShareButton: () => <button>Share</button>,
}))

import { OutfitCard } from '../../src/components/OutfitCard'
import type { OutfitSuggestion } from '../../src/api/outfits'

const base = { item_ids: ['i1'], name: 'Look', occasion: 'casual', reasoning: 'nice' }

describe('OutfitCard — items guard (regression for daily_outfit crash)', () => {
  it('renders without crashing when items is undefined', () => {
    render(<OutfitCard suggestion={{ ...base } as unknown as OutfitSuggestion} showShare />)
    expect(screen.getByText('Look')).toBeInTheDocument()
    expect(screen.getByText('Items no longer available')).toBeInTheDocument()
  })

  it('renders without crashing when items is empty', () => {
    render(<OutfitCard suggestion={{ ...base, items: [] } as unknown as OutfitSuggestion} showShare />)
    expect(screen.getByText('Items no longer available')).toBeInTheDocument()
  })

  it('renders thumbnails when items are present', () => {
    const suggestion = {
      ...base,
      items: [
        { id: 'i1', imageUri: 'images/items/a.jpg', category: 'top', subcategory: 't-shirt' },
        { id: 'i2', imageUri: 'images/items/b.jpg', category: 'bottom', subcategory: 'jeans' },
      ],
    } as unknown as OutfitSuggestion

    render(<OutfitCard suggestion={suggestion} showShare />)
    expect(screen.queryByText('Items no longer available')).not.toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(2)
  })
})
