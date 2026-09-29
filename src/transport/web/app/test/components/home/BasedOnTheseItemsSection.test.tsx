import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BasedOnTheseItemsSection } from '../../../src/components/home/sections/BasedOnTheseItemsSection'

const cachedItems: any[] = []
vi.mock('../../../src/context/ItemCacheContext', () => ({
  useItemCache: () => ({
    items: cachedItems,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  ItemCacheProvider: ({ children }: any) => children,
}))

vi.mock('../../../src/modals/OutfitSaveModal', () => ({
  OutfitSaveModal: vi.fn(({ items, onClose, onSaved }: any) => (
    <div data-testid="outfit-save">
      <span data-testid="outfit-item-count">{items.length}</span>
      <button data-testid="outfit-close" onClick={onClose}>Close</button>
      <button data-testid="outfit-saved" onClick={onSaved}>Saved</button>
    </div>
  )),
}))

function makeItem(id: string): any {
  return {
    id,
    imageUri: `images/items/${id}.jpg`,
    category: 'tops',
    subcategory: `T-shirt ${id}`,
    primaryColor: 'white',
    colors: '["white"]',
    material: 'cotton',
    brand: null,
    size: null,
    season: '["summer"]',
    tags: '["casual"]',
    aiDescription: null,
    occasion: '["casual"]',
    wearContext: null,
    materialSource: null,
    careInstructions: '[]',
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now(),
    tagImageUri: null,
  }
}

function renderSection(props: Partial<Parameters<typeof BasedOnTheseItemsSection>[0]> = {}, cacheItems: any[] = []) {
  cachedItems.length = 0
  cachedItems.push(...cacheItems)
  const defaults = {
    items: [] as any[],
    hasMore: false,
    phase: 'generating' as const,
    onReshuffle: vi.fn(),
    onItemClick: vi.fn(),
  }
  return render(
    <BasedOnTheseItemsSection {...defaults} {...props} />,
  )
}

describe('BasedOnTheseItemsSection', () => {
  it('renders the item grid when items are provided', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty })
    const images = document.querySelectorAll('img[src*="images/items"]')
    expect(images.length).toBe(20)
  })

  it('Select button enters select mode', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty })

    expect(screen.getByText('Select')).toBeTruthy()
    fireEvent.click(screen.getByText('Select'))

    expect(screen.getByText('Outfit')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(screen.queryByText('Select')).toBeNull()
  })

  it('header shows Outfit + Cancel in select mode; Outfit disabled when <2 selected', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty })

    fireEvent.click(screen.getByText('Select'))

    const outfitBtn = screen.getByText('Outfit').closest('button')!
    expect(outfitBtn).toBeDisabled()

    const cancelBtn = screen.getByText('Cancel').closest('button')!
    expect(cancelBtn).not.toBeDisabled()
  })

  it('tap in select mode toggles selection; does not fire onItemClick', () => {
    const onItemClick = vi.fn()
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty, onItemClick })

    fireEvent.click(screen.getByText('Select'))

    const firstItem = document.querySelectorAll('button[class*="aspect-"]')[0]
    fireEvent.click(firstItem)

    expect(onItemClick).not.toHaveBeenCalled()
    let selectedCards = document.querySelectorAll('.border-transparent.animate-border-march')
    expect(selectedCards.length).toBe(1)

    const secondItem = document.querySelectorAll('button[class*="aspect-"]')[1]
    fireEvent.click(secondItem)

    selectedCards = document.querySelectorAll('.border-transparent.animate-border-march')
    expect(selectedCards.length).toBe(2)

    fireEvent.click(secondItem)
    selectedCards = document.querySelectorAll('.border-transparent.animate-border-march')
    expect(selectedCards.length).toBe(1)
  })

  it('tap outside select mode fires onItemClick', () => {
    const onItemClick = vi.fn()
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty, onItemClick })

    const firstItem = document.querySelectorAll('button[class*="aspect-"]')[0]
    fireEvent.click(firstItem)

    expect(onItemClick).toHaveBeenCalledWith('item-0')
  })

  it('selected items carousel renders with X chips; clicking X deselects', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty }, twenty)

    fireEvent.click(screen.getByText('Select'))
    const firstItem = document.querySelectorAll('button[class*="aspect-"]')[0]
    fireEvent.click(firstItem)

    const carouselImgs = document.querySelectorAll('div[class*="shrink-0"] img[class*="object-cover"]')
    expect(carouselImgs.length).toBeGreaterThanOrEqual(1)

    const xButtons = document.querySelectorAll('button[class*="-top-1"][class*="-right-1"]')
    expect(xButtons.length).toBe(1)
    fireEvent.click(xButtons[0])

    const selectedCards = document.querySelectorAll('.border-transparent.animate-border-march')
    expect(selectedCards.length).toBe(0)
  })

  it('Cancel exits select mode and clears selectedIds', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty })

    fireEvent.click(screen.getByText('Select'))
    expect(screen.queryByText('Outfit')).toBeTruthy()

    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Outfit')).toBeNull()
    expect(screen.getByText('Select')).toBeTruthy()
  })

  it('selection survives reshuffle when items prop changes', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    const reshuffled = Array.from({ length: 20 }, (_, i) => makeItem(`reshuffled-${i}`))
    const allCache = [...twenty, ...reshuffled]
    const { rerender } = renderSection({ items: twenty }, allCache)

    fireEvent.click(screen.getByText('Select'))
    const firstItem = document.querySelectorAll('button[class*="aspect-"]')[0]
    fireEvent.click(firstItem)

    const carouselImgs = document.querySelectorAll('div[class*="shrink-0"] img[class*="object-cover"]')
    expect(carouselImgs.length).toBe(1)

    rerender(
      <BasedOnTheseItemsSection
        items={reshuffled}
        hasMore={false}
        phase="generating"
        onReshuffle={vi.fn()}
      />,
    )

    const carouselAfter = document.querySelectorAll('div[class*="shrink-0"] img[class*="object-cover"]')
    expect(carouselAfter.length).toBe(1)
  })

  it('Outfit opens OutfitSaveModal when >=2 selected', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => makeItem(`item-${i}`))
    renderSection({ items: twenty })

    fireEvent.click(screen.getByText('Select'))
    const firstItem = document.querySelectorAll('button[class*="aspect-"]')[0]
    fireEvent.click(firstItem)
    const secondItem = document.querySelectorAll('button[class*="aspect-"]')[1]
    fireEvent.click(secondItem)

    expect(screen.getByText('Outfit').closest('button')).not.toBeDisabled()

    fireEvent.click(screen.getByText('Outfit'))
    expect(screen.getByTestId('outfit-save')).toBeTruthy()
  })

  it('shows spinner during shortlisting phase', () => {
    renderSection({ items: null, phase: 'shortlisting' })
    expect(screen.getByText('Finding items…')).toBeTruthy()
  })

  it('renders nothing when null items and not shortlisting', () => {
    const { container } = renderSection({ items: null, phase: 'generating' })
    expect(container.innerHTML).toBe('')
  })
})
