import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { Closet } from '../../src/pages/Closet'
import { Outfits } from '../../src/pages/Outfits'
import { TryOn } from '../../src/pages/TryOn'
import { installMockIntersectionObserver } from '../helpers/mockIntersectionObserver'

// Stubs needed by j sdom for page-level renders
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
installMockIntersectionObserver()

vi.mock('../../src/context/ItemCacheContext', () => ({
  ItemCacheProvider: ({ children }: { children: React.ReactNode }) => children,
  useItemCache: vi.fn(() => ({
    total: 0,
    items: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

vi.mock('../../src/hooks/useSavedOutfits', () => ({
  useSavedOutfits: vi.fn(() => ({
    outfits: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

vi.mock('../../src/hooks/useCollections', () => ({
  useCollections: vi.fn(() => ({
    collections: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

vi.mock('../../src/hooks/useItems', () => ({
  useItems: vi.fn(() => ({
    items: [],
    total: 0,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

vi.mock('../../src/api/items', () => ({
  fetchItems: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
  deleteItem: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({
  createOutfit: vi.fn(),
  updateOutfit: vi.fn(),
  uploadOutfitCover: vi.fn(),
  deleteOutfit: vi.fn(),
  markOutfitWorn: vi.fn(),
  fetchOutfitsHydrated: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../src/api/collections', () => ({
  fetchCollectionsHydrated: vi.fn(() => Promise.resolve([])),
}))

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: vi.fn(() => Promise.resolve([])),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: vi.fn(),
  fetchTryonHistory: vi.fn(() => Promise.resolve([])),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
}))

vi.mock('../../src/lib/cropImage', () => ({
  cropToAspectRatio: vi.fn((file: File) => Promise.resolve(file)),
}))

vi.mock('../../src/lib/analytics', () => ({
  track: vi.fn(),
}))

vi.mock('../../src/api/jobs', () => ({
  fetchUpcomingJobs: vi.fn(() => Promise.resolve([])),
  fetchJobHistory: vi.fn(() => Promise.resolve([])),
  shareJob: vi.fn(),
  saveJobResult: vi.fn(),
  clearJob: vi.fn(),
}))

import { useItemCache } from '../../src/context/ItemCacheContext'
import { useSavedOutfits } from '../../src/hooks/useSavedOutfits'
import { useCollections } from '../../src/hooks/useCollections'


const mockItem = {
  id: 'item-1',
  imageUri: 'images/items/a.jpg',
  category: 'tops',
  subcategory: 't-shirt',
  primaryColor: 'blue',
  colors: '[]',
  material: null,
  materialSource: null,
  careInstructions: '[]',
  brand: null,
  size: null,
  season: '[]',
  tags: '[]',
  aiDescription: null,
  occasion: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  tagImageUri: null,
}

const mockOutfit = {
  id: 'outfit-1',
  name: 'Casual Friday',
  itemIds: '["item-1"]',
  occasion: 'casual',
  season: '[]',
  aiGenerated: 0,
  weatherContext: null,
  notes: null,
  coverImageUri: null,
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  items: [mockItem],
}

const mockCollection = {
  id: 'col-1',
  name: 'Summer Collection',
  description: null,
  coverImageUri: null,
  season: '[]',
  tags: '[]',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  outfitCount: 1,
  outfits: [mockOutfit],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useItemCache).mockReturnValue({
    items: [mockItem],
    total: 1,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
})

describe('card scale-in animation (animate-grid-in)', () => {
  it('Closet grid has animate-grid-in class', async () => {
    render(<MemoryRouter><Closet /></MemoryRouter>)
    await waitFor(() => {
      const grid = document.querySelector('.animate-grid-in')
      expect(grid).toBeTruthy()
      expect(grid?.className).toContain('grid-cols-3')
    })
  })

  it('Outfits tab grid uses 2-column layout', async () => {
    vi.mocked(useSavedOutfits).mockReturnValue({
      outfits: [mockOutfit],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => {
      const card = document.querySelector('.reveal-card')
      expect(card).toBeTruthy()
      const grid = card?.parentElement
      expect(grid?.className).toContain('grid-cols-2')
    })
  })

  it('Collections tab grid uses reveal-card animation', async () => {
    vi.mocked(useSavedOutfits).mockReturnValue({
      outfits: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    vi.mocked(useCollections).mockReturnValue({
      collections: [mockCollection],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)

    const user = userEvent.setup()
    // Switch to Collections tab
    await user.click(screen.getByRole('button', { name: /^Collections$/i }))

    await waitFor(() => {
      const cards = document.querySelectorAll('.reveal-card')
      expect(cards.length).toBeGreaterThanOrEqual(1)
      const colCard = Array.from(cards).find(el => el.parentElement?.className.includes('grid-cols-2'))
      expect(colCard).toBeTruthy()
    })
  })

  it('TryOn ITEMS tab grid has animate-grid-in class', async () => {
    const mockPhoto = {
      id: 'photo1',
      imageUri: 'images/user/photo1.jpg',
      isPrimary: true,
      createdAt: Date.now(),
    }
    const { fetchUserPhotos } = await import('../../src/api/userPhotos')
    const { fetchTryonHistory } = await import('../../src/api/tryon')
    vi.mocked(fetchUserPhotos).mockResolvedValue([mockPhoto])
    vi.mocked(fetchTryonHistory).mockResolvedValue([])

    render(
      <MemoryRouter initialEntries={[{ state: { outfitItemIds: ['item-1'] } }]}>
        <TryOn />
      </MemoryRouter>,
    )

    await waitFor(() => {
      const grid = document.querySelector('.animate-grid-in')
      expect(grid).toBeTruthy()
      expect(grid?.className).toContain('grid-cols-[repeat')
    })
  })
})
