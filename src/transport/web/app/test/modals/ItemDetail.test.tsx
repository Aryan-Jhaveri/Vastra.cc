import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ItemDetail } from '../../src/modals/ItemDetail'
import { updateItem } from '../../src/api/items'

const mockFetchItemImages = vi.fn().mockResolvedValue([])
const mockFetchItem = vi.fn().mockResolvedValue({}) as ReturnType<typeof vi.fn>
vi.mock('../../src/api/items', () => ({
  deleteItem: vi.fn(),
  updateItem: vi.fn(),
  scanTag: vi.fn(),
  replaceItemImage: vi.fn(),
  fetchItem: (...args: unknown[]) => mockFetchItem(...args),
  fetchItems: vi.fn().mockResolvedValue({ items: [] }),
  fetchItemImages: () => mockFetchItemImages(),
  uploadItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
  generateThumbnail: vi.fn(),
}))

const facets = vi.hoisted(() => ({ tag: [] as Array<{ value: string; items: number; outfits: number; collections: number }>, occasion: [] as Array<{ value: string; items: number; outfits: number; collections: number }> }))
vi.mock('../../src/api/tags', () => ({
  fetchFacets: vi.fn(async (kind: 'tag' | 'occasion') => facets[kind]),
  deleteFacets: vi.fn(),
}))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ src, alt }: { src: string; alt?: string }) => <img data-src={src} alt={alt ?? ''} />,
}))

vi.mock('../../src/components/MakePrettySheet', () => ({
  MakePrettySheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="make-pretty-sheet" /> : null,
}))

vi.mock('../../src/components/ShareButton', () => ({
  ShareButton: ({ className }: { className?: string }) => (
    <button className={className} data-testid="share-button">Share</button>
  ),
}))

// #332 — the Related section is gated on relatedEnabled from /api/auth/status.
const relatedFlag = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../src/hooks/useRelatedEnabled', () => ({ useRelatedEnabled: () => relatedFlag.enabled }))
const shopFlag = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../src/hooks/useShopEnabled', () => ({ useShopEnabled: () => shopFlag.enabled }))
vi.mock('../../src/api/shop', () => ({ fetchShopForItem: vi.fn(), fetchLikedProductIds: vi.fn().mockResolvedValue([]), likeProduct: vi.fn(), unlikeProduct: vi.fn() }))
vi.mock('../../src/api/related', () => ({ findRelated: vi.fn(), fetchSavedRelated: vi.fn().mockResolvedValue(null) }))

const mockItem = {
  id: 'item-1',
  imageUri: 'images/items/a.jpg',
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
  wearContext: null,
  occasion: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  tagImageUri: null,
}

function renderDetail(props?: Partial<Parameters<typeof ItemDetail>[0]>) {
  return render(
    <MemoryRouter>
      <ItemDetail
        item={mockItem as Parameters<typeof ItemDetail>[0]['item']}
        onClose={() => {}}
        onChanged={() => {}}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe('ItemDetail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the pinned bottom action stack with all action buttons', () => {
    renderDetail()
    const actions = screen.getByTestId('itemdetail-actions')
    expect(actions).toBeInTheDocument()
    expect(actions).toHaveTextContent('Generate Thumbnail')
    expect(actions).toHaveTextContent('Try On')
    expect(actions).toHaveTextContent('Delete')
    expect(actions).toHaveTextContent('Cancel')
  })

  it('renders Generate Thumbnail and clicking opens MakePrettySheet', async () => {
    mockFetchItemImages.mockResolvedValueOnce([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ])
    renderDetail()
    expect(screen.queryByTestId('make-pretty-sheet')).not.toBeInTheDocument()
    const btn = await screen.findByRole('button', { name: 'Generate Thumbnail' })
    await screen.findByRole('button', { name: 'Generate Thumbnail' })
    fireEvent.click(btn)
    expect(screen.getByTestId('make-pretty-sheet')).toBeInTheDocument()
  })

  it('renders Try On button', () => {
    renderDetail()
    expect(screen.getByText('Try On')).toBeInTheDocument()
  })

  it('toggles to confirmation row when Delete is clicked', () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('Keep it')).toBeInTheDocument()
    // The confirmation row should now have a Delete button alongside Keep it
    const actions = screen.getByTestId('itemdetail-actions')
    expect(actions).toHaveTextContent('Keep it')
    expect(actions).toHaveTextContent('Delete')
  })

  it('Cancel button invokes onClose', () => {
    const onClose = vi.fn()
    renderDetail({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables Generate Thumbnail and shows "Add a photo first" when item has no reference images', async () => {
    mockFetchItemImages.mockResolvedValueOnce([])
    renderDetail()
    const btn = await screen.findByRole('button', { name: 'Generate Thumbnail' })
    expect(btn).toBeDisabled()
    expect(screen.getByText('Add a photo first')).toBeInTheDocument()
  })

  it('enables Generate Thumbnail when item has at least one non-generated image', async () => {
    mockFetchItemImages.mockResolvedValueOnce([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ])
    renderDetail()
    const btn = await screen.findByRole('button', { name: 'Generate Thumbnail' })
    // findBy waits for re-render; once images load, button enables and helper text disappears.
    await screen.findByRole('button', { name: 'Generate Thumbnail' })
    expect(btn).not.toBeDisabled()
    expect(screen.queryByText('Add a photo first')).not.toBeInTheDocument()
  })

  it('disables Generate Thumbnail when only generated images exist (no real references)', async () => {
    mockFetchItemImages.mockResolvedValueOnce([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'generated', isPrimary: 1, position: 0 },
    ])
    renderDetail()
    const btn = await screen.findByRole('button', { name: 'Generate Thumbnail' })
    expect(btn).toBeDisabled()
    expect(screen.getByText('Add a photo first')).toBeInTheDocument()
  })

  it('action stack lives at the end of the scrollable content area with a visual divider', () => {
    renderDetail()
    const actions = screen.getByTestId('itemdetail-actions')
    // Actions scroll together with the rest of the modal content.
    const scrollableAncestor = actions.closest('.overflow-y-auto')
    expect(scrollableAncestor).not.toBeNull()
    // Visual divider so the section still reads distinct.
    expect(actions.className).toContain('border-t-2')
  })

  it('fetches full item on mount so lean card payloads still render all fields', async () => {
    mockFetchItemImages.mockResolvedValueOnce([])
    const leanItem = {
      ...mockItem,
      material: undefined,
      brand: undefined,
      size: undefined,
      aiDescription: undefined,
    } as unknown as typeof mockItem
    const fullItem = {
      ...mockItem,
      material: 'cotton',
      brand: 'Nike',
      size: 'M',
      aiDescription: 'A nice t-shirt',
    }
    mockFetchItem.mockResolvedValueOnce(fullItem)

    renderDetail({ item: leanItem })

    await waitFor(() => {
      expect(mockFetchItem).toHaveBeenCalledWith('item-1')
      // Material, brand, size now show the fetched values (rendered as text in InlineField read mode)
      expect(screen.getByText('cotton')).toBeInTheDocument()
      expect(screen.getByText('Nike')).toBeInTheDocument()
      expect(screen.getByText('M')).toBeInTheDocument()
    })
    // Description textarea shows the fetched value
    await waitFor(() => {
      expect(screen.getByDisplayValue('A nice t-shirt')).toBeInTheDocument()
    })
  })

  it('multi-select color: adds and removes colors via chips and input', async () => {
    mockFetchItemImages.mockResolvedValueOnce([])
    mockFetchItem.mockResolvedValueOnce(mockItem)
    const updateMock = updateItem as ReturnType<typeof vi.fn>
    updateMock.mockImplementation((_id: string, data: Partial<typeof mockItem>) =>
      Promise.resolve({ ...mockItem, colors: typeof data.colors === 'string' ? data.colors : JSON.stringify(data.colors) })
    )

    renderDetail()

    // Open the color editor by clicking the pencil button next to "Color"
    const colorHeader = screen.getByText('Color')
    const editBtn = colorHeader.closest('div')?.querySelector('button')
    fireEvent.click(editBtn as HTMLElement)

    // Add a color via the input
    const input = screen.getByPlaceholderText('Add color, press Enter')
    fireEvent.change(input, { target: { value: 'navy' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith('item-1', { colors: ['navy'] })
    })
    updateMock.mockClear()

    // Add a second color
    fireEvent.change(input, { target: { value: 'cream' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith('item-1', { colors: ['navy', 'cream'] })
    })
  })
})

describe('ItemDetail — Related section (#332)', () => {
  it('is hidden when no decision provider is configured', () => {
    relatedFlag.enabled = false
    renderDetail()
    expect(screen.queryByTestId('related-item')).toBeNull()
  })

  it('shows above the action buttons when enabled, idle', () => {
    relatedFlag.enabled = true
    renderDetail()
    const section = screen.getByTestId('related-item')
    const actions = screen.getByTestId('itemdetail-actions')
    expect(section.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Find related items' })).toBeEnabled()
    relatedFlag.enabled = false
  })

  it('shows Related shop items only when the shop is enabled', () => {
    shopFlag.enabled = false
    const { unmount } = renderDetail()
    expect(screen.queryByTestId('related-item-shop')).toBeNull()
    unmount()
    shopFlag.enabled = true
    renderDetail()
    expect(screen.getByTestId('related-item-shop')).toBeInTheDocument()
    shopFlag.enabled = false
  })
})

describe('ItemDetail — removing tags and occasions sticks (#371)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a removed custom tag leaves the item and does not come back as a suggestion', async () => {
    const withTag = { ...mockItem, tags: JSON.stringify(['festival']), occasion: JSON.stringify(['gala']) }
    mockFetchItem.mockResolvedValueOnce(withTag)
    // "Your tags" comes from the server's per-user list.
    facets.tag = [{ value: 'denim', items: 1, outfits: 0, collections: 0 }]
    vi.mocked(updateItem).mockImplementation((_id, data) => Promise.resolve({
      ...withTag,
      ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
      ...(data.occasion !== undefined ? { occasion: JSON.stringify(data.occasion) } : {}),
    } as never))

    renderDetail({ item: withTag as never })
    fireEvent.click(await screen.findByRole('button', { name: 'Remove festival' }))
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith('item-1', { tags: [] }))
    await waitFor(() => expect(screen.queryByText('festival')).not.toBeInTheDocument())
    // Other items' tags are still offered.
    expect(screen.getByText('denim')).toBeInTheDocument()
  })

  it('an occasion is removed with its ×', async () => {
    const withOcc = { ...mockItem, occasion: JSON.stringify(['gala']) }
    mockFetchItem.mockResolvedValueOnce(withOcc)
    vi.mocked(updateItem).mockImplementation((_id, data) => Promise.resolve({ ...withOcc, occasion: JSON.stringify(data.occasion) } as never))

    renderDetail({ item: withOcc as never })
    const header = await screen.findByText('Occasion')
    fireEvent.click(header.parentElement!.querySelector('button') as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove gala' }))
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith('item-1', { occasion: [] }))
    await waitFor(() => expect(screen.queryByText('gala')).not.toBeInTheDocument())
  })
})
