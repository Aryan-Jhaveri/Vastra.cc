import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/api/items', () => ({
  generateThumbnail: vi.fn(),
  setItemImagePrimary: vi.fn(),
  fetchItemImages: vi.fn(),
}))

import * as api from '../../src/api/items'
import { MakePrettySheet } from '../../src/components/MakePrettySheet'

function renderSheet(overrides: Partial<Parameters<typeof MakePrettySheet>[0]> = {}) {
  return render(
    <MakePrettySheet
      itemId="item-1"
      imageUri="images/items/cover.jpg"
      label="Blue T-Shirt"
      open={true}
      onClose={vi.fn()}
      onUsed={vi.fn()}
      {...overrides}
    />,
  )
}

describe('MakePrettySheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows confirm sheet when open', async () => {
    vi.mocked(api.fetchItemImages).mockResolvedValue([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any)

    renderSheet()

    expect(screen.getAllByText('generate thumbnail')[0]).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/reference photos/)).toBeInTheDocument()
    })
  })

  it('shows counter "0 / 8" and "using cover as reference" when no natural refs', async () => {
    vi.mocked(api.fetchItemImages).mockResolvedValue([])

    renderSheet()

    await waitFor(() => {
      expect(screen.getByText('0 / 8')).toBeInTheDocument()
    })
    expect(screen.getByText(/using cover as reference/)).toBeInTheDocument()
  })

  it('shows counter "1 / 8" for single ref', async () => {
    vi.mocked(api.fetchItemImages).mockResolvedValue([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any)

    renderSheet()

    await waitFor(() => {
      expect(screen.getByText('1 / 8')).toBeInTheDocument()
    })
    expect(screen.getByText(/add more for better results/)).toBeInTheDocument()
  })

  it('shows counter "8 / 8" for eight refs', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      id: `img-${i}`,
      imageUri: `images/items/${i}.jpg`,
      role: 'reference',
      isPrimary: i === 0 ? 1 : 0,
      position: i,
    })) as any
    vi.mocked(api.fetchItemImages).mockResolvedValue(eight)

    renderSheet()

    await waitFor(() => {
      expect(screen.getByText('8 / 8')).toBeInTheDocument()
    })
  })

  it('shows counter "9 / 8" with warning for nine refs', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      id: `img-${i}`,
      imageUri: `images/items/${i}.jpg`,
      role: 'reference',
      isPrimary: i === 0 ? 1 : 0,
      position: i,
    })) as any
    vi.mocked(api.fetchItemImages).mockResolvedValue(nine)

    renderSheet()

    await waitFor(() => {
      expect(screen.getByText('9 / 8')).toBeInTheDocument()
    })
    expect(screen.getByText(/remove some in gallery/)).toBeInTheDocument()
  })

  it('calls runGenerate directly when clicking generate thumbnail (no no-source gate)', async () => {
    // Even with zero refs, clicking "generate thumbnail" should call the API directly
    vi.mocked(api.fetchItemImages).mockResolvedValue([])
    vi.mocked(api.generateThumbnail).mockResolvedValue({
      image: { id: 'gen-1', imageUri: 'images/items/gen.jpg', role: 'generated' } as any,
      imageUri: 'images/items/gen.jpg',
    })

    renderSheet()

    await waitFor(() => {
      expect(screen.getByText('0 / 8')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'generate thumbnail' }))

    await waitFor(() => {
      expect(api.generateThumbnail).toHaveBeenCalledWith('item-1', { instruction: undefined })
    })
  })

  it('fires onGenerated after generation completes', async () => {
    vi.mocked(api.fetchItemImages).mockResolvedValue([])
    vi.mocked(api.generateThumbnail).mockResolvedValue({
      image: { id: 'gen-1', imageUri: 'images/items/gen.jpg', role: 'generated' } as any,
      imageUri: 'images/items/gen.jpg',
    })

    const onGenerated = vi.fn()
    renderSheet({ onGenerated })

    await waitFor(() => {
      expect(screen.getByText('0 / 8')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'generate thumbnail' }))

    await waitFor(() => {
      expect(screen.getByText('choose your cover')).toBeInTheDocument()
    })

    expect(onGenerated).toHaveBeenCalledOnce()
  })

  it('generating sheet is dismissable', async () => {
    vi.mocked(api.fetchItemImages).mockResolvedValue([])
    // never-resolving promise so the sheet stays in 'generating'
    vi.mocked(api.generateThumbnail).mockReturnValue(new Promise(() => {}))

    const onClose = vi.fn()
    renderSheet({ onClose })

    await waitFor(() => {
      expect(screen.getByText('0 / 8')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'generate thumbnail' }))

    await waitFor(() => {
      expect(screen.getByText('generating product photo')).toBeInTheDocument()
    })

    // close button should be visible and dismissable
    const closeBtn = screen.getByText('close')
    expect(closeBtn).toBeInTheDocument()
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })
})
