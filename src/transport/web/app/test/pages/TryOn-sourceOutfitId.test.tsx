import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'

const mockGenerateTryOn = vi.fn()
const mockFetchHistory = vi.fn().mockResolvedValue([])
const mockLinkTryon = vi.fn().mockResolvedValue({})
const mockFetchOutfits = vi.fn().mockResolvedValue([])
const mockUploadOutfitCover = vi.fn().mockResolvedValue({})
const mockCreateOutfit = vi.fn()
const mockFetchUserPhotos = vi.fn()
const mockTrack = vi.fn()
const mockUploadUserPhoto = vi.fn()

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: () => mockFetchUserPhotos(),
  uploadUserPhoto: (...args: unknown[]) => mockUploadUserPhoto(...args),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: (...args: unknown[]) => mockGenerateTryOn(...args),
  fetchTryonHistory: () => mockFetchHistory(),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
  fetchWearSuggestions: vi.fn().mockResolvedValue([]),
  linkTryonToOutfit: (...args: unknown[]) => mockLinkTryon(...args),
}))

vi.mock('../../src/api/outfits', () => ({
  fetchOutfitsHydrated: () => mockFetchOutfits(),
  uploadOutfitCover: (...args: unknown[]) => mockUploadOutfitCover(...args),
  createOutfit: (...args: unknown[]) => mockCreateOutfit(...args),
}))

vi.mock('../../src/lib/analytics', () => ({
  track: (...args: unknown[]) => mockTrack(...args),
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
      {
        id: 'item-2', imageUri: 'images/items/jeans.jpg', category: 'bottoms', subcategory: 'jeans',
        primaryColor: 'blue', colors: JSON.stringify(['blue']), brand: null, size: null, season: '[]',
        tags: '[]', aiDescription: null, material: 'denim', occasion: '[]', wearContext: undefined,
        tagImageUri: null, thumbImageUri: null, careInstructions: '[]', materialSource: null,
        userId: 'self', createdAt: 0, updatedAt: 0, wornAt: null, embedUpdatedAt: null, textEmbedUpdatedAt: null,
      },
    ],
    loading: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({ lat: null, lon: null, name: '' }),
}))

vi.mock('../../src/lib/cropImage', () => ({
  cropToAspectRatio: (file: File) => Promise.resolve(file),
}))

vi.mock('../../src/lib/usePasteImage', () => ({
  usePasteImage: () => {},
}))

import { TryOn } from '../../src/pages/TryOn'

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchHistory.mockResolvedValue([])
  mockFetchOutfits.mockResolvedValue([])
  mockLinkTryon.mockResolvedValue({})
  mockUploadOutfitCover.mockResolvedValue({})
  mockFetchUserPhotos.mockResolvedValue([
    { id: 'p-1', imageUri: 'images/userphotos/p.jpg', label: null, isPrimary: 1, createdAt: 0 },
  ])
  mockGenerateTryOn.mockResolvedValue({
    resultImageUri: 'images/tryon/r.jpg',
    tryonId: 't-1',
    wearSuggestions: [],
  })
  // handleUpdateOutfitCover fetches the result image to build a File for the cover upload
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderFromOutfit() {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: '/tryon', state: { outfitItemIds: ['item-1'], sourceOutfitId: 'outfit-9' } }]}
    >
      <TryOn />
    </MemoryRouter>,
  )
}

describe('TryOn — save from a source outfit', () => {
  it('updates the source outfit cover instead of creating a new outfit', async () => {
    renderFromOutfit()

    // Photo auto-selects and the page jumps to pick-items because outfitItemIds is in router state.
    const generate = await screen.findByRole('button', { name: /generate preview/i })
    fireEvent.click(generate)

    // The result step exposes "Update outfit cover" (not "Save outfit") because sourceOutfitId is set.
    const updateCover = await screen.findByRole('button', { name: /update outfit cover/i })
    expect(screen.queryByRole('button', { name: /^save outfit$/i })).toBeNull()
    // The source outfit goes along as refine-chip context (#312).
    expect(mockGenerateTryOn.mock.calls[0][4]).toBe('outfit-9')

    fireEvent.click(updateCover)

    await waitFor(() => {
      expect(mockUploadOutfitCover).toHaveBeenCalledWith('outfit-9', expect.any(File))
    })
    expect(mockLinkTryon).toHaveBeenCalledWith('t-1', 'outfit-9')
    expect(mockCreateOutfit).not.toHaveBeenCalled()
  })
})

describe('TryOn — "Try On" from an outfit opened inside Try On', () => {
  function NavigateToOutfit() {
    const navigate = useNavigate()
    return (
      <button onClick={() => navigate('/tryon', { state: { outfitItemIds: ['item-2'], sourceOutfitId: 'outfit-2' } })}>
        test: open other outfit
      </button>
    )
  }

  it('replaces the previous selection and result with the new outfit (same-route navigation)', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/tryon', state: { outfitItemIds: ['item-1'], sourceOutfitId: 'outfit-9' } }]}>
        <TryOn />
        <NavigateToOutfit />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /generate preview/i }))
    await screen.findByRole('button', { name: /update outfit cover/i })
    expect(mockGenerateTryOn.mock.calls[0]![1]).toEqual(['item-1'])

    // Same route, new router state: the page must not keep item-1 or the old result.
    fireEvent.click(screen.getByRole('button', { name: /test: open other outfit/i }))
    fireEvent.click(await screen.findByRole('button', { name: /generate preview/i }))

    await waitFor(() => expect(mockGenerateTryOn).toHaveBeenCalledTimes(2))
    expect(mockGenerateTryOn.mock.calls[1]![0]).toBe('p-1')
    expect(mockGenerateTryOn.mock.calls[1]![1]).toEqual(['item-2'])
  })
})

describe('TryOn — "Try On" from an item card (#356)', () => {
  function renderFromItem() {
    return render(
      <MemoryRouter initialEntries={[{ pathname: '/tryon', state: { itemId: 'item-2' } }]}>
        <TryOn />
      </MemoryRouter>,
    )
  }

  it('pre-selects the item and skips to pick-items when a photo exists', async () => {
    renderFromItem()

    const generate = await screen.findByRole('button', { name: /generate preview/i })
    expect(generate).not.toBeDisabled()
    fireEvent.click(generate)

    await waitFor(() => expect(mockGenerateTryOn).toHaveBeenCalledTimes(1))
    expect(mockGenerateTryOn.mock.calls[0]![0]).toBe('p-1')
    expect(mockGenerateTryOn.mock.calls[0]![1]).toEqual(['item-2'])
    // Item path must not surface the outfit-cover action.
    expect(screen.queryByRole('button', { name: /update outfit cover/i })).toBeNull()
  })

  it('stays on the photo step with no photos but keeps the selection', async () => {
    mockFetchUserPhotos.mockResolvedValue([])
    mockUploadUserPhoto.mockResolvedValue(
      { id: 'p-new', imageUri: 'images/userphotos/n.jpg', label: null, isPrimary: 0, createdAt: 0 },
    )
    const { container } = renderFromItem()

    const selectItems = await screen.findByRole('button', { name: /select items/i })
    await waitFor(() => expect(mockFetchUserPhotos).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /generate preview/i })).toBeNull()
    expect(selectItems).toBeDisabled()

    // Add a photo, then continue manually — item-2 is still selected.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'me.jpg', { type: 'image/jpeg' })] } })
    await waitFor(() => expect(selectItems).not.toBeDisabled())
    fireEvent.click(selectItems)

    const generate = await screen.findByRole('button', { name: /generate preview/i })
    expect(generate).not.toBeDisabled()
    fireEvent.click(generate)
    await waitFor(() => expect(mockGenerateTryOn).toHaveBeenCalledTimes(1))
    expect(mockGenerateTryOn.mock.calls[0]![0]).toBe('p-new')
    expect(mockGenerateTryOn.mock.calls[0]![1]).toEqual(['item-2'])
  })

  it('re-applies an item selection on same-route navigation', async () => {
    function NavigateToItem() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/tryon', { state: { itemId: 'item-2' } })}>test: try on item</button>
    }
    render(
      <MemoryRouter initialEntries={[{ pathname: '/tryon', state: { outfitItemIds: ['item-1'], sourceOutfitId: 'outfit-9' } }]}>
        <TryOn />
        <NavigateToItem />
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: /generate preview/i })

    fireEvent.click(screen.getByRole('button', { name: /test: try on item/i }))
    fireEvent.click(await screen.findByRole('button', { name: /generate preview/i }))
    await waitFor(() => expect(mockGenerateTryOn).toHaveBeenCalledTimes(1))
    expect(mockGenerateTryOn.mock.calls[0]![1]).toEqual(['item-2'])
  })
})
