import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router'
import type { Item } from '../../src/api/items'
import type { AppSettings, SettingsPatch } from '../../src/api/settings'

// #329 — Settings › Sizes. A tiny in-memory "server" backs both the settings
// and items APIs, so edits round-trip the same way they would over HTTP and
// ItemDetail (which re-fetches its item) sees a size edited here.

const server = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  items: new Map<string, Record<string, unknown>>(),
}))

vi.mock('../../src/api/settings', () => ({
  fetchSettings: vi.fn(async () => ({ ...server.settings })),
  saveSettings: vi.fn(async (patch: SettingsPatch) => {
    const { userSizes, ...rest } = patch
    Object.assign(server.settings, rest)
    if (userSizes) {
      for (const v of Object.values(userSizes)) {
        if (typeof v === 'string' && v.length > 30) throw new Error('Invalid userSizes')
      }
      const merged = { ...(server.settings.userSizes as Record<string, string> | undefined) }
      for (const [k, v] of Object.entries(userSizes)) {
        if (v === null || v === '') delete merged[k]
        else merged[k] = v
      }
      server.settings.userSizes = merged
    }
    return { ...server.settings } as AppSettings
  }),
}))

vi.mock('../../src/api/items', () => ({
  fetchItems: vi.fn(async () => {
    const items = [...server.items.values()]
    return { items, total: items.length, page: 1, pageSize: 100 }
  }),
  fetchItem: vi.fn(async (id: string) => ({ ...server.items.get(id) })),
  updateItem: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const next = { ...server.items.get(id), ...patch }
    server.items.set(id, next)
    return next
  }),
  fetchItemImages: vi.fn().mockResolvedValue([]),
  deleteItem: vi.fn(),
  scanTag: vi.fn(),
  replaceItemImage: vi.fn(),
  uploadItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
  generateThumbnail: vi.fn(),
}))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ alt }: { alt?: string }) => <img alt={alt ?? ''} />,
}))
vi.mock('../../src/components/MakePrettySheet', () => ({ MakePrettySheet: () => null }))
vi.mock('../../src/components/ShareButton', () => ({ ShareButton: () => null }))
vi.mock('../../src/lib/analytics', () => ({ track: vi.fn() }))

import { saveSettings } from '../../src/api/settings'
import { updateItem } from '../../src/api/items'
import { SettingsSizes } from '../../src/pages/SettingsSizes'
import { ItemDetail } from '../../src/modals/ItemDetail'

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id, imageUri: `images/items/${id}.jpg`, category: 'tops', subcategory: `sub-${id}`, primaryColor: null,
    colors: '[]', material: null, materialSource: null, careInstructions: '[]', brand: null, size: null,
    season: '[]', tags: '[]', aiDescription: null, wearContext: null, occasion: '[]', timesWorn: 0,
    lastWornAt: null, createdAt: 1, tagImageUri: null, ...over,
  }
}

function renderAt(path = '/settings/sizes') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<p>settings page</p>} />
        <Route path="/settings/sizes" element={<SettingsSizes />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  server.settings = {}
  server.items = new Map()
})

describe('SettingsSizes — page shell', () => {
  it('renders as a direct link and goes back to Settings', async () => {
    renderAt()
    expect(screen.getByText('Sizes.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(await screen.findByText('settings page')).toBeInTheDocument()
  })
})

describe('SettingsSizes — My sizes', () => {
  it('shows the primary categories in order and hides the rest behind "+ Add a size"', async () => {
    renderAt()
    await waitFor(() => expect(screen.getByText('Tops')).toBeInTheDocument())
    const labels = ['Tops', 'Bottoms', 'Outerwear', 'Dresses', 'Shoes'].map(l => screen.getByText(l))
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i - 1].compareDocumentPosition(labels[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(screen.queryByText('Accessories')).not.toBeInTheDocument()
    expect(screen.queryByText('Underwear')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('+ Add a size'))
    expect(screen.getByText('Accessories')).toBeInTheDocument()
    expect(screen.getByText('Underwear')).toBeInTheDocument()
    expect(screen.getByText('Activewear')).toBeInTheDocument()
    expect(screen.queryByText('+ Add a size')).not.toBeInTheDocument()
  })

  it('shows a hidden category that already has a value', async () => {
    server.settings = { userSizes: { accessories: 'OS' } }
    renderAt()
    expect(await screen.findByText('OS')).toBeInTheDocument()
    expect(screen.getByText('Accessories')).toBeInTheDocument()
  })

  it('edits and saves a size, then shows the saved value', async () => {
    server.settings = { userSizes: { tops: 'M' } }
    renderAt()
    fireEvent.click(await screen.findByText('M'))
    const input = screen.getByDisplayValue('M')
    fireEvent.change(input, { target: { value: ' L ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ userSizes: { tops: 'L' } }))
    expect(await screen.findByText('L')).toBeInTheDocument()
    expect(server.settings.userSizes).toEqual({ tops: 'L' })
  })

  it('clearing a size sends an empty value (removes the key)', async () => {
    server.settings = { userSizes: { shoes: 'US 10' } }
    renderAt()
    fireEvent.click(await screen.findByText('US 10'))
    const input = screen.getByDisplayValue('US 10')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ userSizes: { shoes: '' } }))
    await waitFor(() => expect(server.settings.userSizes).toEqual({}))
  })

  it('caps input at 30 characters', async () => {
    renderAt()
    await screen.findByText('Tops')
    const topsRow = screen.getByText('Tops').parentElement!
    fireEvent.click(within(topsRow).getByRole('button'))
    expect(within(topsRow).getByRole('textbox')).toHaveAttribute('maxLength', '30')
  })
})

describe('SettingsSizes — agent context toggle', () => {
  it('defaults to On and persists Off', async () => {
    renderAt()
    const toggle = await screen.findByRole('switch', { name: 'Use my sizes in Ask' })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle).toHaveTextContent('On')
    fireEvent.click(toggle)
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ sizesAgentContext: false }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(toggle).toHaveTextContent('Off')
    expect(server.settings.sizesAgentContext).toBe(false)
  })

  it('reads a saved Off from the server', async () => {
    server.settings = { sizesAgentContext: false }
    renderAt()
    const toggle = await screen.findByRole('switch', { name: 'Use my sizes in Ask' })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })
})

describe('SettingsSizes — Sizes on your items', () => {
  beforeEach(() => {
    server.items.set('a', item('a', { size: 'M' }))
    server.items.set('b', item('b'))
    server.items.set('c', item('c', { size: '32 × 30', category: 'bottoms' }))
  })

  it('shows "N of M set", size badges and No size badges', async () => {
    renderAt()
    expect(await screen.findByText('Sizes on your items · 2 of 3 set')).toBeInTheDocument()
    expect(within(screen.getByTestId('size-item-a')).getByText('M')).toBeInTheDocument()
    expect(within(screen.getByTestId('size-item-b')).getByText('No size')).toBeInTheDocument()
    expect(within(screen.getByTestId('size-item-c')).getByText('32 × 30')).toBeInTheDocument()
  })

  function shown() {
    return screen.queryAllByTestId(/^size-item-/).map(el => el.getAttribute('data-testid')!.replace('size-item-', '')).sort()
  }

  it('All / With size / Without size isolate the lists and show matching counts (#369)', async () => {
    renderAt()
    const group = await screen.findByRole('radiogroup', { name: 'Filter items by size' })
    expect(within(group).getByRole('radio', { name: 'All · 3' })).toHaveAttribute('aria-checked', 'true')
    expect(shown()).toEqual(['a', 'b', 'c'])

    fireEvent.click(within(group).getByRole('radio', { name: 'With size · 2' }))
    expect(shown()).toEqual(['a', 'c'])
    fireEvent.click(within(group).getByRole('radio', { name: 'Without size · 1' }))
    expect(shown()).toEqual(['b'])
    fireEvent.click(within(group).getByRole('radio', { name: 'All · 3' }))
    expect(shown()).toEqual(['a', 'b', 'c'])
  })

  it('the filter control sits above the grid', async () => {
    renderAt()
    const group = await screen.findByRole('radiogroup', { name: 'Filter items by size' })
    expect(group.compareDocumentPosition(screen.getByTestId('size-item-a')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('an item given a size under "Without size" leaves that list, and the counts move', async () => {
    renderAt()
    const group = await screen.findByRole('radiogroup', { name: 'Filter items by size' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Without size · 1' }))
    fireEvent.click(within(screen.getByTestId('size-item-b')).getByRole('button'))
    const input = await screen.findByPlaceholderText('e.g. M')
    fireEvent.change(input, { target: { value: 'L' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(shown()).toEqual([]))
    expect(screen.getByText('Every item has a size.')).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'With size · 3' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Without size · 0' })).toBeInTheDocument()
  })

  it('tapping an item edits its size through PATCH /api/items/:id, and ItemDetail shows it', async () => {
    renderAt()
    await screen.findByTestId('size-item-b')
    fireEvent.click(within(screen.getByTestId('size-item-b')).getByRole('button'))
    const input = await screen.findByPlaceholderText('e.g. M')
    fireEvent.change(input, { target: { value: 'S' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith('b', { size: 'S' }))
    await waitFor(() => expect(within(screen.getByTestId('size-item-b')).getByText('S')).toBeInTheDocument())
    expect(screen.getByText('Sizes on your items · 3 of 3 set')).toBeInTheDocument()

    // ItemDetail opened with the stale card re-fetches the item and shows the new size.
    render(
      <MemoryRouter>
        <ItemDetail item={item('b')} onClose={() => {}} onChanged={() => {}} />
      </MemoryRouter>,
    )
    const sizeLabel = await screen.findByText('Size')
    await waitFor(() => expect(within(sizeLabel.parentElement!).getByText('S')).toBeInTheDocument())
  })

  it('an unchanged value does not PATCH the item', async () => {
    renderAt()
    await screen.findByTestId('size-item-a')
    fireEvent.click(within(screen.getByTestId('size-item-a')).getByRole('button'))
    const input = await screen.findByDisplayValue('M')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByDisplayValue('M')).not.toBeInTheDocument())
    expect(updateItem).not.toHaveBeenCalled()
  })
})
