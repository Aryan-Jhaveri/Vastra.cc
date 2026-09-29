import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { Outfits } from '../../src/pages/Outfits'

vi.mock('../../src/hooks/useSavedOutfits', () => ({
  useSavedOutfits: vi.fn(),
}))

vi.mock('../../src/hooks/useItems', () => ({
  useItems: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({
  createOutfit: vi.fn(),
  updateOutfit: vi.fn(),
  uploadOutfitCover: vi.fn(),
  deleteOutfit: vi.fn(),
  markOutfitWorn: vi.fn(),
  fetchOutfitsHydrated: vi.fn(),
}))

import * as savedOutfitsHook from '../../src/hooks/useSavedOutfits'
import * as itemsHook from '../../src/hooks/useItems'

const mockItem = {
  id: 'item-1',
  imageUri: 'images/items/a.jpg',
  category: 'tops',
  subcategory: 't-shirt',
  primaryColor: 'blue',
  colors: '[]',
  material: null,
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
  tags: '[]',
  aiGenerated: 0,
  weatherContext: null,
  notes: null,
  coverImageUri: null,
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  items: [mockItem],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(itemsHook.useItems).mockReturnValue({
    items: [mockItem],
    total: 1,
    loading: false,
    error: null,
    refetch: vi.fn(),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Outfits page', () => {
  it('shows empty state when no outfits', async () => {
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/No saved outfits yet/i)).toBeInTheDocument())
  })

  it('renders outfit cards', async () => {
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [mockOutfit],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Casual Friday')).toBeInTheDocument())
  })

  it('filters by occasion', async () => {
    const user = userEvent.setup()
    const workOutfit = { ...mockOutfit, id: 'outfit-2', name: 'Work Look', occasion: 'work' }
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [mockOutfit, workOutfit],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Casual Friday'))

    // Open the Occasion Radix Select and pick 'work'
    await user.click(screen.getByRole('combobox', { name: 'Occasion' }))
    await user.click(await screen.findByRole('option', { name: /^work$/i }))

    expect(screen.queryByText('Casual Friday')).not.toBeInTheDocument()
    expect(screen.getByText('Work Look')).toBeInTheDocument()
  })

  it('shows skeleton while loading', () => {
    vi.useFakeTimers()
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [],
      loading: true,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByText('Vastra')).toBeInTheDocument()
  })
})

describe('SavedOutfitCard thumbnails', () => {
  it('shows item thumbnails when no cover photo', async () => {
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [mockOutfit],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Casual Friday'))
    // item image should be rendered
    const imgs = document.querySelectorAll('img')
    const itemImg = Array.from(imgs).find(img => img.getAttribute('data-src')?.includes('images/items/a.jpg'))
    expect(itemImg).toBeTruthy()
  })

  it('shows cover photo when available', async () => {
    const withCover = { ...mockOutfit, coverImageUri: 'images/outfits/cover.jpg' }
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: [withCover],
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Casual Friday'))
    const coverImg = Array.from(document.querySelectorAll('img')).find(img => img.getAttribute('data-src')?.includes('images/outfits/cover.jpg'))
    expect(coverImg).toBeTruthy()
  })
})

describe('Outfits occasion filter', () => {
  it('dedupes mixed-case occasions in dropdown', async () => {
    const user = userEvent.setup()
    const mixedCaseOutfits = [
      { ...mockOutfit, id: 'o1', name: 'Fit One', occasion: 'Formal' },
      { ...mockOutfit, id: 'o2', name: 'Fit Two', occasion: 'FORMAL' },
      { ...mockOutfit, id: 'o3', name: 'Fit Three', occasion: 'formal' },
    ]
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: mixedCaseOutfits,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Fit One'))

    await user.click(screen.getByRole('combobox', { name: 'Occasion' }))
    const formalOptions = await screen.findAllByRole('option', { name: /^formal$/i })
    expect(formalOptions.length).toBe(1)
  })

  it('matches occasion case-insensitively', async () => {
    const user = userEvent.setup()
    const mixedCaseOutfits = [
      { ...mockOutfit, id: 'o1', name: 'Formal Outfit', occasion: 'FORMAL' },
      { ...mockOutfit, id: 'o2', name: 'Casual Outfit', occasion: 'casual' },
    ]
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: mixedCaseOutfits,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Formal Outfit'))

    await user.click(screen.getByRole('combobox', { name: 'Occasion' }))
    await user.click(await screen.findByRole('option', { name: /^formal$/i }))

    expect(screen.getByText('Formal Outfit')).toBeInTheDocument()
    expect(screen.queryByText('Casual Outfit')).not.toBeInTheDocument()
  })
})

describe('Outfits tag filter', () => {
  it('dedupes mixed-case tags in dropdown', async () => {
    const user = userEvent.setup()
    const mixedCaseOutfits = [
      { ...mockOutfit, id: 'o1', name: 'Fit One', tags: JSON.stringify(['Formal']) },
      { ...mockOutfit, id: 'o2', name: 'Fit Two', tags: JSON.stringify(['FORMAL']) },
      { ...mockOutfit, id: 'o3', name: 'Fit Three', tags: JSON.stringify(['formal']) },
    ]
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: mixedCaseOutfits,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Fit One'))

    await user.click(screen.getByText('Tags'))
    await waitFor(() => {
      const formalButtons = screen.queryAllByText('formal').filter(el => el.tagName === 'BUTTON')
      expect(formalButtons.length).toBe(1)
    })
  })

  it('matches tags case-insensitively', async () => {
    const user = userEvent.setup()
    const mixedCaseOutfits = [
      { ...mockOutfit, id: 'o1', name: 'Formal Outfit', tags: JSON.stringify(['FORMAL']) },
      { ...mockOutfit, id: 'o2', name: 'Casual Outfit', tags: JSON.stringify(['casual']) },
    ]
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: mixedCaseOutfits,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })

    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Formal Outfit'))

    await user.click(screen.getByText('Tags'))
    await waitFor(() => {
      const formalButtons = screen.queryAllByText('formal').filter(el => el.tagName === 'BUTTON')
      expect(formalButtons.length).toBeGreaterThanOrEqual(1)
    })
    const formalButton = screen.queryAllByText('formal').find(el => el.tagName === 'BUTTON')!
    await user.click(formalButton)

    expect(screen.getByText('Formal Outfit')).toBeInTheDocument()
    expect(screen.queryByText('Casual Outfit')).not.toBeInTheDocument()
  })
})

describe('Outfits search (#288)', () => {
  const brunchOutfit = {
    ...mockOutfit,
    id: 'outfit-brunch',
    name: 'Brunch Fit',
    occasion: 'brunch',
    season: '["winter"]',
    tags: '["cozy"]',
    items: [{ ...mockItem, id: 'item-1', brand: 'Nike', colors: '["navy"]', material: 'linen' }],
  }
  const workOutfit = {
    ...mockOutfit,
    id: 'outfit-work',
    name: 'Work Fit',
    occasion: 'work',
    season: '["summer"]',
    tags: '[]',
    items: [{ ...mockItem, id: 'item-2', brand: 'Uniqlo', colors: '["grey"]', material: 'cotton' }],
  }
  const aiOutfit = { ...brunchOutfit, id: 'outfit-ai', name: 'AI Fit', aiGenerated: 1 }

  function mockOutfits(outfits: unknown[]) {
    vi.mocked(savedOutfitsHook.useSavedOutfits).mockReturnValue({
      outfits: outfits as never,
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
  }

  async function typeSearch(user: ReturnType<typeof userEvent.setup>, q: string) {
    await user.type(screen.getByPlaceholderText('Search outfits…'), q)
  }

  it('matches an outfit by occasion', async () => {
    const user = userEvent.setup()
    mockOutfits([brunchOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'brunch')

    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })

  it('matches an outfit by season', async () => {
    const user = userEvent.setup()
    mockOutfits([brunchOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'winter')

    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })

  it('matches an outfit by tag', async () => {
    const user = userEvent.setup()
    mockOutfits([brunchOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'cozy')

    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })

  it('matches an AI-generated outfit by the query "ai"', async () => {
    const user = userEvent.setup()
    mockOutfits([aiOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('AI Fit'))

    await typeSearch(user, 'ai')

    expect(screen.getByText('AI Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })

  it('matches through a nested item color or material', async () => {
    const user = userEvent.setup()
    mockOutfits([brunchOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'navy')
    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()

    await user.clear(screen.getByPlaceholderText('Search outfits…'))
    await typeSearch(user, 'linen')
    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })

  it('matches when only a nested item matches', async () => {
    const user = userEvent.setup()
    const quietOutfit = { ...workOutfit, name: 'Plain Fit', occasion: null, season: '[]', tags: '[]', notes: null }
    mockOutfits([brunchOutfit, quietOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'uniqlo')

    expect(screen.getByText('Plain Fit')).toBeInTheDocument()
    expect(screen.queryByText('Brunch Fit')).not.toBeInTheDocument()
  })

  it('still matches name and combines with the occasion filter', async () => {
    const user = userEvent.setup()
    mockOutfits([brunchOutfit, workOutfit])
    render(<MemoryRouter><Outfits /></MemoryRouter>)
    await waitFor(() => screen.getByText('Brunch Fit'))

    await typeSearch(user, 'brunch')
    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Occasion' }))
    await user.click(await screen.findByRole('option', { name: /^brunch$/i }))
    expect(screen.getByText('Brunch Fit')).toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Occasion' }))
    await user.click(await screen.findByRole('option', { name: /^work$/i }))
    expect(screen.queryByText('Brunch Fit')).not.toBeInTheDocument()
    expect(screen.queryByText('Work Fit')).not.toBeInTheDocument()
  })
})
