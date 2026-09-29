import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { TryOn } from '../../src/pages/TryOn'

vi.mock('../../src/context/ItemCacheContext', () => ({
  ItemCacheProvider: ({ children }: { children: React.ReactNode }) => children,
  useItemCache: vi.fn(() => ({ items: [], loading: false, error: null, refetch: vi.fn() })),
}))

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: vi.fn(),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/items', () => ({ fetchItems: vi.fn() }))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: vi.fn(),
  fetchTryonHistory: vi.fn(),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
  fetchWearSuggestions: vi.fn(),
  linkTryonToOutfit: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({ fetchOutfitsHydrated: vi.fn(), uploadOutfitCover: vi.fn() }))
vi.mock('../../src/api/share', () => ({ getShare: vi.fn() }))
vi.mock('../../src/lib/cropImage', () => ({ cropToAspectRatio: vi.fn((f: File) => Promise.resolve(f)) }))
vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'test-id') }))

import * as userPhotosApi from '../../src/api/userPhotos'
import * as tryonApi from '../../src/api/tryon'
import * as shareApi from '../../src/api/share'

const mockPhoto = { id: 'photo1', imageUri: 'images/user/photo1.jpg', isPrimary: true, createdAt: Date.now() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([mockPhoto] as never)
  vi.mocked(tryonApi.fetchTryonHistory).mockResolvedValue([] as never)
})

describe('TryOn — PWA share inbox pre-load', () => {
  it('?inboxId pre-loads the shared image as a garment and jumps to the Upload step', async () => {
    vi.mocked(shareApi.getShare).mockResolvedValue({
      id: 'inbox-1',
      source: 'share_inbox',
      description: 'Shared image',
      imageUris: ['images/share-inbox/abc.jpg'],
      senderHandle: null,
      createdAt: Date.now(),
      expiresAt: null,
      outfit: null,
    })

    render(
      <MemoryRouter initialEntries={['/tryon?inboxId=inbox-1']}>
        <TryOn />
      </MemoryRouter>,
    )

    // Lands on step 2 (pick-items) with the Upload tab active.
    await waitFor(() => expect(screen.getByText(/Upload garment photos/i)).toBeInTheDocument())
    expect(shareApi.getShare).toHaveBeenCalledWith('inbox-1')

    // The shared image is registered as a garment (already server-side — no re-upload).
    await waitFor(() => {
      expect(document.querySelector('img[src="/images/share-inbox/abc.jpg"]')).not.toBeNull()
    })
    expect(tryonApi.uploadGarment).not.toHaveBeenCalled()
  })
})
