import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { OutfitDetail } from '../../src/modals/OutfitDetail'

vi.mock('../../src/api/outfits', () => ({
  updateOutfit: vi.fn(),
  uploadOutfitCover: vi.fn(),
  removeOutfitCover: vi.fn(),
  deleteOutfit: vi.fn(),
}))

vi.mock('../../src/api/settings', () => ({
  fetchSettings: vi.fn().mockResolvedValue({ telegramChatId: '123456789' }),
}))

vi.mock('../../src/modals/JobModal', () => ({
  JobModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="job-modal">
      <button onClick={onClose}>Close Modal</button>
    </div>
  ),
}))

import * as outfitsApi from '../../src/api/outfits'

const mockOutfit = {
  id: 'outfit-1',
  name: 'Summer Vibes',
  occasion: 'casual',
  season: '["summer"]',
  tags: '[]',
  notes: null,
  coverImageUri: null,
  aiGenerated: 0,
  weatherContext: null,
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  itemIds: '["item-1"]',
  items: [
    { id: 'item-1', imageUri: 'images/items/a.jpg', category: 'top', subcategory: 't-shirt', primaryColor: 'white' },
  ],
}

// What DELETE /api/outfits/:id/cover resolves with: the DB row, no items key.
const coverlessRow = {
  id: 'outfit-1',
  name: 'Summer Vibes',
  occasion: 'casual',
  season: '["summer"]',
  tags: '[]',
  notes: null,
  coverImageUri: null,
  aiGenerated: 0,
  weatherContext: null,
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  itemIds: '["item-1"]',
}

const coveredOutfit = { ...mockOutfit, coverImageUri: 'images/outfits/cover.jpg' }

function renderDetail(props?: Partial<Parameters<typeof OutfitDetail>[0]>) {
  return render(
    <MemoryRouter>
      <OutfitDetail
        outfit={mockOutfit as Parameters<typeof OutfitDetail>[0]['outfit']}
        onClose={() => {}}
        onChanged={() => {}}
        {...props}
      />
    </MemoryRouter>,
  )
}

function coverImg() {
  return Array.from(document.querySelectorAll('img')).find(img => img.getAttribute('data-src') === '/images/outfits/cover.jpg')
}

function coverSectionImgs() {
  return Array.from(document.querySelectorAll('img'))
    .filter(img => img.closest('label')?.textContent?.includes('Add Cover'))
    .map(img => img.getAttribute('data-src'))
}

describe('OutfitDetail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders Schedule button', () => {
    renderDetail()
    expect(screen.getByText('Schedule')).toBeInTheDocument()
  })

  it('opens JobModal when Schedule button is clicked', () => {
    renderDetail()
    fireEvent.click(screen.getByText('Schedule'))
    expect(screen.getByTestId('job-modal')).toBeInTheDocument()
  })

  it('closes JobModal when modal onClose is called', () => {
    renderDetail()
    fireEvent.click(screen.getByText('Schedule'))
    expect(screen.getByTestId('job-modal')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Close Modal'))
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
  })
})

describe('OutfitDetail — remove cover (#297)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clears the cover locally and shows the item mosaic with the add-cover affordance', async () => {
    vi.mocked(outfitsApi.removeOutfitCover).mockResolvedValue(coverlessRow)
    const onChanged = vi.fn()
    renderDetail({ outfit: coveredOutfit as Parameters<typeof OutfitDetail>[0]['outfit'], onChanged })

    expect(coverImg()).toBeTruthy()
    fireEvent.click(screen.getByText('Remove'))

    await waitFor(() => {
      expect(coverImg()).toBeFalsy()
    })
    expect(onChanged).toHaveBeenCalled()

    // Empty state is the item mosaic, not the dashed upload label
    expect(screen.queryByText('Add Cover Photo')).not.toBeInTheDocument()
    const addCoverBadge = screen.getByText('Add Cover')
    const label = addCoverBadge.closest('label')
    expect(label).toBeTruthy()
    expect(label?.querySelector('input[type="file"]')).toBeTruthy()
    expect(coverSectionImgs()).toContain('/images/items/a.jpg')
  })

  it('shows the dashed upload label only when the outfit has no items', () => {
    renderDetail({ outfit: { ...mockOutfit, items: [] } as Parameters<typeof OutfitDetail>[0]['outfit'] })
    expect(screen.getByText('Add Cover Photo')).toBeInTheDocument()
    expect(screen.queryByText('Add Cover')).not.toBeInTheDocument()
  })

  it('keeps the cover and shows the error banner when removal fails', async () => {
    vi.mocked(outfitsApi.removeOutfitCover).mockRejectedValueOnce(new Error('Internal server error'))
    renderDetail({ outfit: coveredOutfit as Parameters<typeof OutfitDetail>[0]['outfit'] })

    fireEvent.click(screen.getByText('Remove'))

    await waitFor(() => {
      expect(screen.getByText('Error: Internal server error')).toBeInTheDocument()
    })
    expect(coverImg()).toBeTruthy()
    expect(screen.queryByText('Add Cover')).not.toBeInTheDocument()
  })

  it('clears a previous error banner when a retry succeeds', async () => {
    vi.mocked(outfitsApi.removeOutfitCover)
      .mockRejectedValueOnce(new Error('Internal server error'))
      .mockResolvedValue(coverlessRow)
    renderDetail({ outfit: coveredOutfit as Parameters<typeof OutfitDetail>[0]['outfit'] })

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => {
      expect(screen.getByText('Error: Internal server error')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => {
      expect(screen.queryByText('Error: Internal server error')).not.toBeInTheDocument()
    })
    expect(coverImg()).toBeFalsy()
    expect(screen.getByText('Add Cover')).toBeInTheDocument()
  })
})
