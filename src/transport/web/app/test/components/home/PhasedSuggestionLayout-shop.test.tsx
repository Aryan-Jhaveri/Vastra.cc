import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { UseDiscoverStreamReturn } from '../../../src/hooks/useDiscoverStream'
import type { ShopRankContext } from '../../../src/api/shop'

// #336 — the shop row is ranked against the closet items and saved outfits
// the run shows, never the AI recommendations, so it doesn't wait on the model.
const shopProps = vi.hoisted(() => ({ calls: [] as Array<ShopRankContext | null> }))
vi.mock('../../../src/components/home/sections/RelatedShopItemsSection', () => ({
  RelatedShopItemsSection: (p: { rankContext: ShopRankContext | null }) => { shopProps.calls.push(p.rankContext); return null },
}))
vi.mock('../../../src/components/home/sections/BasedOnTheseItemsSection', () => ({ BasedOnTheseItemsSection: () => null }))
vi.mock('../../../src/components/home/sections/RelatedOutfitsSection', () => ({ RelatedOutfitsSection: () => null }))
vi.mock('../../../src/components/home/sections/AIRecommendationsSection', () => ({ AIRecommendationsSection: () => null }))
vi.mock('../../../src/hooks/useShopEnabled', () => ({ useShopEnabled: () => true }))
vi.mock('../../../src/api/shop', () => ({ fetchLikedProductIds: vi.fn().mockResolvedValue([]) }))

import { PhasedSuggestionLayout } from '../../../src/components/home/PhasedSuggestionLayout'

function stream(phase: UseDiscoverStreamReturn['phase']): UseDiscoverStreamReturn {
  return {
    phase,
    shopQuery: { query: 'linen shirt' },
    visibleItems: [{ id: 'i1' }, { id: 'i2' }],
    visibleOutfits: [{ id: 'o1' }],
    suggestions: phase === 'done'
      ? [{ name: 'Weekend', occasion: 'casual', reasoning: 'Light layers', item_ids: ['i1'], items: [] }]
      : null,
  } as unknown as UseDiscoverStreamReturn
}

function layout(phase: UseDiscoverStreamReturn['phase']) {
  return <PhasedSuggestionLayout stream={stream(phase)} onReshuffleItems={vi.fn()} onReshuffleOutfits={vi.fn()} />
}

describe('PhasedSuggestionLayout — shop rank context (#336)', () => {
  it('carries item and outfit ids while the AI is still generating', () => {
    render(layout('generating'))
    expect(shopProps.calls.at(-1)).toEqual({ itemIds: ['i1', 'i2'], outfitIds: ['o1'], recommendations: [] })
  })

  it('never includes the AI recommendations, even once they arrive', () => {
    render(layout('done'))
    expect(shopProps.calls.at(-1)).toEqual({ itemIds: ['i1', 'i2'], outfitIds: ['o1'], recommendations: [] })
  })
})
