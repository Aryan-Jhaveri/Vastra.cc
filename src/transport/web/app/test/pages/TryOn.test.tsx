import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { TryOn } from '../../src/pages/TryOn'

vi.mock('../../src/context/ItemCacheContext', () => ({
  ItemCacheProvider: ({ children }: { children: React.ReactNode }) => children,
  useItemCache: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: vi.fn(),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/items', () => ({
  fetchItems: vi.fn(),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: vi.fn(),
  fetchTryonHistory: vi.fn(),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({
  fetchOutfitsHydrated: vi.fn(),
}))

vi.mock('../../src/lib/cropImage', () => ({
  cropToAspectRatio: vi.fn((file: File) => Promise.resolve(file)),
}))

// nanoid returns predictable IDs in tests
vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'test-id') }))

import * as userPhotosApi from '../../src/api/userPhotos'
import * as itemsApi from '../../src/api/items'
import * as tryonApi from '../../src/api/tryon'

const mockPhoto = {
  id: 'photo1',
  imageUri: 'images/user/photo1.jpg',
  isPrimary: true,
  createdAt: Date.now(),
}

const mockItem = {
  id: 'item1',
  imageUri: 'images/items/item1.jpg',
  category: 'tops',
  subcategory: 't-shirt',
  primaryColor: 'white',
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

function renderTryOn() {
  return render(
    <MemoryRouter>
      <TryOn />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([mockPhoto])
  vi.mocked(tryonApi.fetchTryonHistory).mockResolvedValue([])
  vi.mocked(itemsApi.fetchItems).mockResolvedValue({ items: [mockItem], total: 1 })
})

describe('Clipboard paste', () => {
  function dispatchPaste(
    target: EventTarget,
    items: Array<{ type: string; getAsFile: () => File | null }>,
  ) {
    fireEvent.paste(target, {
      clipboardData: { items },
    })
  }

  it('shows paste hint on empty upload area', async () => {
    vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([])
    renderTryOn()
    await waitFor(() => expect(screen.getByText(/ctrl\+v/i)).toBeInTheDocument())
  })

  it('uploads image on paste while on pick-photo step', async () => {
    vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([])
    vi.mocked(userPhotosApi.uploadUserPhoto).mockResolvedValue(mockPhoto)
    renderTryOn()

    await waitFor(() => expect(screen.getByText(/ctrl\+v/i)).toBeInTheDocument())

    const blob = new Blob(['test'], { type: 'image/png' })
    const file = new File([blob], 'pasted.png', { type: 'image/png' })
    dispatchPaste(document, [{ type: 'image/png', getAsFile: () => file }])

    await waitFor(() => {
      expect(userPhotosApi.uploadUserPhoto).toHaveBeenCalled()
    })
  })

  it('ignores paste of non-image content', async () => {
    vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([])
    renderTryOn()

    await waitFor(() => expect(screen.getByText(/ctrl\+v/i)).toBeInTheDocument())

    dispatchPaste(document, [{ type: 'text/plain', getAsFile: () => null }])

    expect(userPhotosApi.uploadUserPhoto).not.toHaveBeenCalled()
  })

  it('ignores paste while target is a text input', async () => {
    vi.mocked(userPhotosApi.fetchUserPhotos).mockResolvedValue([])
    vi.mocked(userPhotosApi.uploadUserPhoto).mockResolvedValue(mockPhoto)
    renderTryOn()

    await waitFor(() => expect(screen.getByText(/ctrl\+v/i)).toBeInTheDocument())

    const input = document.createElement('input')
    document.body.appendChild(input)
    const blob = new Blob(['test'], { type: 'image/png' })
    const file = new File([blob], 'pasted.png', { type: 'image/png' })
    dispatchPaste(input, [{ type: 'image/png', getAsFile: () => file }])
    input.remove()

    expect(userPhotosApi.uploadUserPhoto).not.toHaveBeenCalled()
  })
})

describe('Upload extras step', () => {
  async function navigateToExtras() {
    renderTryOn()
    // Wait for photos to load then proceed to step 2
    await waitFor(() => expect(screen.getByText(/Select Items/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Select Items/))
    // Step 2: click the "upload" tab
    await waitFor(() => expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }))
    await waitFor(() => expect(screen.getByText(/Upload garment photos/i)).toBeInTheDocument())
  }

  it('renders upload extras step with empty state and upload zone', async () => {
    await navigateToExtras()
    expect(screen.getByText(/Upload garment photos/i)).toBeInTheDocument()
    expect(screen.getByText(/Generate Preview/i)).toBeInTheDocument()
  })

  it('shows Generate button disabled when no items selected and no uploads', async () => {
    await navigateToExtras()
    const generateBtn = screen.getByRole('button', { name: /Generate Preview/i })
    expect(generateBtn).toBeDisabled()
  })

  it('disables Generate button while garment is uploading', async () => {
    // uploadGarment never resolves — simulates uploading state
    vi.mocked(tryonApi.uploadGarment).mockReturnValue(new Promise(() => {}))

    await navigateToExtras()

    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement
    const file = new File(['data'], 'garment.jpg', { type: 'image/jpeg' })

    // Mock URL.createObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:test')

    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      const generateBtn = screen.getByRole('button', { name: /Generate Preview/i })
      expect(generateBtn).toBeDisabled()
    })
  })

  it('removes garment from list when Remove is clicked', async () => {
    vi.mocked(tryonApi.uploadGarment).mockResolvedValue({ imageUri: 'images/garments/abc.jpg' })
    URL.createObjectURL = vi.fn(() => 'blob:test')

    await navigateToExtras()

    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement
    const file = new File(['data'], 'garment.jpg', { type: 'image/jpeg' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    // Wait for upload to complete and × button to appear
    await waitFor(() => {
      const removeBtn = screen.queryByRole('button', { name: /remove/i })
      expect(removeBtn).toBeInTheDocument()
    })

    const removeBtn = screen.getByRole('button', { name: /remove/i })
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
    })
  })

  it('calls generateTryOn with garmentUris when extras are uploaded', async () => {
    vi.mocked(tryonApi.uploadGarment).mockResolvedValue({ imageUri: 'images/garments/abc.jpg' })
    vi.mocked(tryonApi.generateTryOn).mockResolvedValue({ resultImageUri: 'images/tryon/r.jpg', tryonId: 't1' })
    URL.createObjectURL = vi.fn(() => 'blob:test')

    await navigateToExtras()

    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement
    const file = new File(['data'], 'garment.jpg', { type: 'image/jpeg' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    // Wait for upload to finish
    await waitFor(() => expect(screen.queryByRole('button', { name: /remove/i })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /Generate Preview/i }))

    await waitFor(() => {
      expect(tryonApi.generateTryOn).toHaveBeenCalledWith(
        'photo1',
        expect.any(Array),
        ['images/garments/abc.jpg'],
        undefined,
        undefined, // no source outfit
      )
    })
  })

  it('fills the shared panel height with the rounded drop-zone (#287)', async () => {
    await navigateToExtras()

    const dropZone = screen.getByText(/Upload garment photos/i).closest('label')!
    expect(dropZone.className).toContain('flex-1')
    expect(dropZone.className).toContain('rounded-base')
    expect(dropZone.className).toContain('mt-3')

    const panel = dropZone.parentElement!
    expect(panel.className).toContain('min-h-[calc(100dvh_-_240px)]')
    expect(panel.className).toContain('flex flex-col')
  })

  it('themes the uploaded-garment remove button with a usable hit area (#287)', async () => {
    vi.mocked(tryonApi.uploadGarment).mockResolvedValue({ imageUri: 'images/garments/abc.jpg' })
    URL.createObjectURL = vi.fn(() => 'blob:test')

    await navigateToExtras()

    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement
    const file = new File(['data'], 'garment.jpg', { type: 'image/jpeg' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    const removeBtn = await screen.findByRole('button', { name: /remove/i })
    expect(removeBtn.className).toContain('w-7 h-7')
    expect(removeBtn.className).toContain('border-2')
    expect(removeBtn.className).toContain('bg-paper')
    expect(removeBtn.className).not.toContain('bg-accent')
  })
})
