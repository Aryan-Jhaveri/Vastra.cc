import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const mockGenerateTryOn = vi.fn()
const mockFetchHistory = vi.fn().mockResolvedValue([])
const mockLinkTryon = vi.fn().mockResolvedValue({})
const mockDeleteTryonResult = vi.fn()
const mockFetchOutfits = vi.fn().mockResolvedValue([])
const mockUploadOutfitCover = vi.fn().mockResolvedValue({})
const mockCreateOutfit = vi.fn()
const mockFetchUserPhotos = vi.fn()
const mockTrack = vi.fn()

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: () => mockFetchUserPhotos(),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: (...args: unknown[]) => mockGenerateTryOn(...args),
  fetchTryonHistory: () => mockFetchHistory(),
  deleteTryonResult: (...args: unknown[]) => mockDeleteTryonResult(...args),
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
    ],
    loading: false,
    refetch: vi.fn(),
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

const fetchMock = vi.fn((url: string) =>
  Promise.resolve({
    ok: true,
    blob: async () => new Blob([`body:${url}`], { type: 'image/jpeg' }),
  }),
)

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// Enter TryOn with items pre-selected (the Home → recommendation → Try On path).
function renderWithOutfitItems() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/tryon', state: { outfitItemIds: ['item-1'] } }]}>
      <TryOn />
    </MemoryRouter>,
  )
}

async function generateResult() {
  fireEvent.click(await screen.findByRole('button', { name: /generate preview/i }))
  await screen.findByRole('button', { name: 'Save outfit' })
}

async function saveThroughBuilder() {
  fireEvent.click(screen.getByRole('button', { name: 'Save outfit' }))
  const nameInput = await screen.findByPlaceholderText(/weekend casual/i)
  fireEvent.change(nameInput, { target: { value: 'My Look' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Outfit' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchHistory.mockResolvedValue([])
  mockFetchOutfits.mockResolvedValue([])
  mockLinkTryon.mockResolvedValue({})
  mockUploadOutfitCover.mockResolvedValue({})
  mockDeleteTryonResult.mockResolvedValue(undefined)
  mockCreateOutfit.mockResolvedValue({ id: 'outfit-1', name: 'My Look', itemIds: '["item-1"]' })
  mockFetchUserPhotos.mockResolvedValue([
    { id: 'p-1', imageUri: 'images/userphotos/p.jpg', label: null, isPrimary: 1, createdAt: 0 },
  ])
  mockGenerateTryOn.mockResolvedValue({
    resultImageUri: 'images/tryon/r.jpg',
    tryonId: 't-1',
    wearSuggestions: [],
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TryOn — save generated result as outfit (#285)', () => {
  it('flips Save outfit to View outfit right away, links the try-on, and uploads the generated image as the cover', async () => {
    renderWithOutfitItems()
    await generateResult()
    await saveThroughBuilder()

    await waitFor(() => expect(mockLinkTryon).toHaveBeenCalledWith('t-1', 'outfit-1'))
    await waitFor(() => expect(mockUploadOutfitCover).toHaveBeenCalledWith('outfit-1', expect.any(File)))

    // The cover upload was called with the generated result image.
    const coverFile = mockUploadOutfitCover.mock.calls[0][1] as File
    expect(await readFileText(coverFile)).toBe('body:/images/tryon/r.jpg')

    // Button flipped — a second tap can't create a duplicate.
    expect(await screen.findByRole('button', { name: 'View outfit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save outfit' })).toBeNull()
    expect(mockCreateOutfit).toHaveBeenCalledTimes(1)
  })

  it('still links the outfit and flips the button when the cover upload fails, with a visible retry', async () => {
    mockUploadOutfitCover.mockRejectedValueOnce(new Error('cover upload failed'))

    renderWithOutfitItems()
    await generateResult()
    await saveThroughBuilder()

    expect(await screen.findByRole('button', { name: 'View outfit' })).toBeInTheDocument()
    expect(mockLinkTryon).toHaveBeenCalledWith('t-1', 'outfit-1')
    expect(mockUploadOutfitCover).toHaveBeenCalledWith('outfit-1', expect.any(File))

    // Retry re-attempts just the cover and clears the error on success.
    const retry = await screen.findByRole('button', { name: /retry cover/i })
    mockUploadOutfitCover.mockClear()
    fireEvent.click(retry)
    await waitFor(() => expect(mockUploadOutfitCover).toHaveBeenCalledWith('outfit-1', expect.any(File)))
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry cover/i })).toBeNull())
    expect(screen.getByRole('button', { name: 'View outfit' })).toBeInTheDocument()
  })

  it('links the try-on the user is viewing, not a stale history[0]', async () => {
    let resolveHistory!: (v: unknown) => void
    mockFetchHistory.mockImplementation(() => new Promise(res => { resolveHistory = res }))

    renderWithOutfitItems()
    await generateResult()

    // A slow history response from step 1 lands after generate and replaces
    // the list with server rows that don't include the fresh t-1 result.
    await act(async () => {
      resolveHistory([
        { id: 'h-old', userPhotoId: 'p-1', outfitId: null, itemIds: '[]', resultImageUri: 'images/tryon/old.jpg', promptInstruction: null, createdAt: 0 },
      ])
    })

    await saveThroughBuilder()

    await waitFor(() => expect(mockLinkTryon).toHaveBeenCalledWith('t-1', 'outfit-1'))
    expect(mockLinkTryon).not.toHaveBeenCalledWith('h-old', 'outfit-1')
    expect(await screen.findByRole('button', { name: 'View outfit' })).toBeInTheDocument()
  })
})
