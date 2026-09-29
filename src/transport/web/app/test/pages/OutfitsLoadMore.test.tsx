import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Outfits } from '../../src/pages/Outfits'
import { installMockIntersectionObserver, type MockIOHandle } from '../helpers/mockIntersectionObserver'

vi.mock('../../src/hooks/useSavedOutfits', () => ({
  useSavedOutfits: vi.fn(),
}))

vi.mock('../../src/hooks/useCollections', () => ({
  useCollections: vi.fn(),
}))

vi.mock('../../src/hooks/useItems', () => ({
  useItems: vi.fn(),
}))

import * as savedOutfitsHook from '../../src/hooks/useSavedOutfits'
import * as collectionsHook from '../../src/hooks/useCollections'
import * as itemsHook from '../../src/hooks/useItems'

function buildOutfit(i: number) {
  return {
    id: `outfit-${i}`,
    name: `Outfit ${i}`,
    itemIds: '[]',
    occasion: null,
    season: '[]',
    tags: '[]',
    aiGenerated: 0,
    weatherContext: null,
    notes: null,
    coverImageUri: null,
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now() - (30 - i) * 1000,
    items: [],
  }
}

describe('Outfits load-more sentinel', () => {
  let io: MockIOHandle

  beforeEach(() => {
    vi.clearAllMocks()
    io = installMockIntersectionObserver()

    vi.mocked(itemsHook.useItems).mockReturnValue({
      items: [],
      total: 0,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    vi.mocked(collectionsHook.useCollections).mockReturnValue({
      collections: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads 12 → 24 → 30 outfits as sentinel becomes visible repeatedly', async () => {
    const total = 30
    const mockOutfits = Array.from({ length: total }, (_, i) => buildOutfit(i + 1))

    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: mockOutfits,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)

    // Batch 1: first 12 are visible, 13th is not
    expect(screen.queryByText('Outfit 1')).toBeInTheDocument()
    expect(screen.queryByText('Outfit 12')).toBeInTheDocument()
    expect(screen.queryByText('Outfit 13')).not.toBeInTheDocument()

    // Trigger the sentinel (the last IntersectionObserver callback)
    expect(io.callbacks.length).toBeGreaterThan(0)
    act(() => {
      io.lastCallback([{ isIntersecting: true }])
    })

    // Batch 2: now 24 visible, 25th is not
    expect(screen.queryByText('Outfit 13')).toBeInTheDocument()
    expect(screen.queryByText('Outfit 24')).toBeInTheDocument()
    expect(screen.queryByText('Outfit 25')).not.toBeInTheDocument()

    // Trigger the sentinel again (new instance with key=24)
    act(() => {
      io.lastCallback([{ isIntersecting: true }])
    })

    // Batch 3: all 30 visible, sentinel is gone (hasMore=false)
    expect(screen.queryByText('Outfit 25')).toBeInTheDocument()
    expect(screen.queryByText('Outfit 30')).toBeInTheDocument()
  })
})
