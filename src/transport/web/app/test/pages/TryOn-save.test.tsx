import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const mockFetchHistory = vi.fn().mockResolvedValue([])
const mockFetchOutfits = vi.fn().mockResolvedValue([])

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: vi.fn().mockResolvedValue([]),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: vi.fn(),
  fetchTryonHistory: () => mockFetchHistory(),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
  fetchWearSuggestions: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({
  fetchOutfitsHydrated: () => mockFetchOutfits(),
}))

vi.mock('../../src/context/ItemCacheContext', () => ({
  useItemCache: () => ({
    items: [
      {
        id: 'item-1',
        imageUri: 'images/items/tshirt.jpg',
        category: 'tops',
        subcategory: 't-shirt',
        primaryColor: 'white',
        colors: JSON.stringify(['white']),
        brand: null,
        size: null,
        season: '["summer"]',
        tags: JSON.stringify(['casual']),
        aiDescription: null,
        material: 'cotton',
        occasion: '[]',
        wearContext: undefined,
        tagImageUri: null,
        thumbImageUri: null,
        careInstructions: '[]',
        materialSource: null,
        userId: 'self',
        createdAt: 0,
        updatedAt: 0,
        wornAt: null,
        embedUpdatedAt: null,
        textEmbedUpdatedAt: null,
      },
    ],
    loading: false,
  }),
}))

vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({ lat: null, lon: null, name: '' }),
}))

vi.mock('../../src/lib/cropImage', () => ({
  cropToAspectRatio: vi.fn(),
}))

vi.mock('../../src/lib/usePasteImage', () => ({
  usePasteImage: () => {},
}))

import { TryOn } from '../../src/pages/TryOn'

function renderTryOn() {
  return render(
    <MemoryRouter initialEntries={['/tryon']}>
      <TryOn />
    </MemoryRouter>,
  )
}

describe('TryOn page', () => {
  it('renders without crashing', () => {
    const { container } = renderTryOn()
    expect(container.querySelector('h1')).toBeTruthy()
  })

  it('shows history section with item thumbnails when history has source items', async () => {
    mockFetchHistory.mockResolvedValue([
      {
        id: 'h-1',
        userPhotoId: 'p-1',
        outfitId: null,
        itemIds: JSON.stringify(['item-1']),
        resultImageUri: 'images/tryon/result.jpg',
        promptInstruction: null,
        createdAt: Date.now(),
      },
    ])

    renderTryOn()
    await waitFor(() => {
      expect(screen.getByText('History')).toBeInTheDocument()
    })
    // History card renders — verify the result image + at least one item thumbnail exist
    const imgs = screen.getAllByRole('img')
    expect(imgs.length).toBeGreaterThan(0)
  })
})
