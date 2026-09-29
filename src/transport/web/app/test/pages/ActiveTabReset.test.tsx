import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { MemoryRouter } from 'react-router'
import { PageResetProvider, usePageReset } from '../../src/context/PageResetContext'

// ── jsdom polyfills ───────────────────────────────────────────────────────────
beforeAll(() => {
  if (typeof IntersectionObserver === 'undefined') {
    ;(globalThis as any).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return [] }
    }
  }
  if (!window.scrollTo) {
    window.scrollTo = vi.fn() as any
  }
})

// ── Shared mocks ──────────────────────────────────────────────────────────────
vi.mock('../../src/context/ItemCacheContext', () => ({
  ItemCacheProvider: ({ children }: { children: React.ReactNode }) => children,
  useItemCache: vi.fn(() => ({
    items: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

const mockPhoto = {
  id: 'p1',
  imageUri: 'images/user/p1.jpg',
  isPrimary: true,
  createdAt: Date.now(),
}

vi.mock('../../src/api/userPhotos', () => ({
  fetchUserPhotos: vi.fn().mockResolvedValue([mockPhoto]),
  uploadUserPhoto: vi.fn(),
  deleteUserPhoto: vi.fn(),
}))

vi.mock('../../src/api/items', () => ({
  fetchItems: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}))

vi.mock('../../src/api/tryon', () => ({
  generateTryOn: vi.fn(),
  fetchTryonHistory: vi.fn().mockResolvedValue([]),
  deleteTryonResult: vi.fn(),
  uploadGarment: vi.fn(),
  fetchWearSuggestions: vi.fn().mockResolvedValue([]),
  linkTryonToOutfit: vi.fn(),
}))

vi.mock('../../src/api/outfits', () => ({
  fetchOutfitsHydrated: vi.fn().mockResolvedValue([]),
  uploadOutfitCover: vi.fn(),
  deleteOutfit: vi.fn(),
}))

vi.mock('../../src/hooks/useSavedOutfits', () => ({
  useSavedOutfits: () => ({
    outfits: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock('../../src/hooks/useCollections', () => ({
  useCollections: () => ({
    collections: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock('../../src/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: { handle: '', telegramChatId: null, pushEnabled: false },
    loading: false,
    error: null,
    update: vi.fn(),
    refetch: vi.fn(),
  }),
}))

vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({
    lat: null, lon: null, name: '',
    geocode: vi.fn(),
    clearLocation: vi.fn(),
  }),
}))

// Hosted UI (billing, legal) is tested under test/hosted/; here the hosted
// index is the open-source stub, so this file runs in both repos.
vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))

vi.mock('../../src/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ state: { subscribed: false, loading: false, error: null }, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}))

vi.mock('../../src/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ canInstall: false, isInstalled: false, install: vi.fn() }),
}))

vi.mock('../../src/api/share', () => ({
  fetchMyShares: vi.fn().mockResolvedValue([]),
  deleteShare: vi.fn(),
}))

vi.mock('../../src/api/settings', () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn(),
}))

vi.mock('../../src/lib/cropImage', () => ({
  cropToAspectRatio: vi.fn((file: File) => Promise.resolve(file)),
}))

vi.mock('../../src/lib/usePasteImage', () => ({
  usePasteImage: vi.fn(),
}))

vi.mock('../../src/lib/analytics', () => ({
  initAnalytics: vi.fn(),
  track: vi.fn(),
}))

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'test-id') }))

vi.mock('../../src/lib/theme', () => {
  const dark = {
    '--color-ink': '#ffffff', '--color-paper': '#0a0a0a',
    '--color-muted': '#9b9b9b', '--color-active': '#e0e0e0',
    '--color-surface': '#1a1a1a', '--color-surface-dim': '#141414',
    '--color-surface-bright': '#2a2a2a',
    '--color-surface-variant': '#333333',
    '--color-on-surface': '#ffffff', '--color-on-surface-variant': '#bfbfbf',
    '--color-inverse-surface': '#f0f0f0', '--color-inverse-on-surface': '#1a1a1a',
    '--color-outline': '#999999', '--color-outline-variant': '#404040',
    '--color-primary': '#ffffff', '--color-on-primary': '#0a0a0a',
    '--color-primary-container': '#404040', '--color-on-primary-container': '#ffffff',
    '--color-secondary': '#b3b3b3', '--color-on-secondary': '#1a1a1a',
    '--color-sc-lowest': '#0a0a0a', '--color-sc-low': '#141414',
    '--color-sc': '#1a1a1a', '--color-sc-high': '#2a2a2a', '--color-sc-highest': '#333333',
    '--color-accent': '#ffffff', '--color-accent-on': '#0a0a0a',
    '--color-error': '#dc2626', '--color-on-error': '#ffffff',
    '--color-success': '#16a34a',
  }
  const light = {
    '--color-ink': '#0a0a0a', '--color-paper': '#ffffff',
    '--color-muted': '#6b6b6b', '--color-active': '#1a1a1a',
    '--color-surface': '#f5f5f5', '--color-surface-dim': '#ebebeb',
    '--color-surface-bright': '#ffffff',
    '--color-surface-variant': '#e0e0e0',
    '--color-on-surface': '#0a0a0a', '--color-on-surface-variant': '#404040',
    '--color-inverse-surface': '#1a1a1a', '--color-inverse-on-surface': '#f0f0f0',
    '--color-outline': '#666666', '--color-outline-variant': '#bfbfbf',
    '--color-primary': '#0a0a0a', '--color-on-primary': '#ffffff',
    '--color-primary-container': '#e0e0e0', '--color-on-primary-container': '#0a0a0a',
    '--color-secondary': '#4a4a4a', '--color-on-secondary': '#ffffff',
    '--color-sc-lowest': '#ffffff', '--color-sc-low': '#f7f7f7',
    '--color-sc': '#f0f0f0', '--color-sc-high': '#e8e8e8', '--color-sc-highest': '#e0e0e0',
    '--color-accent': '#0a0a0a', '--color-accent-on': '#ffffff',
    '--color-error': '#dc2626', '--color-on-error': '#ffffff',
    '--color-success': '#16a34a',
  }
  return {
    applyAccountThemePreference: vi.fn(),
    applyLocalThemePreference: vi.fn(),
    applyThemePreference: vi.fn(),
    THEMES: [
      { id: 'brutalist', label: 'Brutalist', description: '', previewBg: '#fff', previewAccent: '#0a0a0a', light, dark },
    ],
    loadSavedTheme: vi.fn(() => 'brutalist'),
    loadSavedCustomPalettes: vi.fn(() => ({})),
    loadSavedCustomPaletteSlot: vi.fn(() => null),
  }
})

// ── Reset trigger helper component ────────────────────────────────────────────
function ResetTrigger({ page }: { page: string }) {
  const { triggerReset } = usePageReset()
  return <button data-testid={`reset-${page}`} onClick={() => triggerReset(page)}>Reset {page}</button>
}

function renderPageWithReset(Page: React.ComponentType<any>, pageKey: string, extraProps?: Record<string, any>) {
  return render(
    <MemoryRouter>
      <PageResetProvider>
        <Page {...(extraProps || {})} />
        <ResetTrigger page={pageKey} />
      </PageResetProvider>
    </MemoryRouter>
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TryOn — active tab reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.scrollTo = vi.fn()
  })

  it('resets from step 2 back to step 1 landing view', async () => {
    const { TryOn } = await import('../../src/pages/TryOn')
    renderPageWithReset(TryOn, 'tryon')

    await waitFor(() => expect(screen.getByText(/Select Items/)).toBeInTheDocument())

    screen.getByText(/Select Items/).click()
    await waitFor(() => expect(screen.getByRole('button', { name: /generate preview/i })).toBeInTheDocument())

    act(() => { screen.getByTestId('reset-tryon').click() })
    await waitFor(() => expect(screen.getByText(/Select Items/)).toBeInTheDocument())
  })

  it('clears item selection on reset', async () => {
    const { TryOn } = await import('../../src/pages/TryOn')
    const { useItemCache } = await import('../../src/context/ItemCacheContext')

    vi.mocked(useItemCache).mockReturnValue({
      items: [{
        id: 'i1', imageUri: 'images/items/i1.jpg',
        category: 'tops', subcategory: 't-shirt', primaryColor: 'white',
        colors: '[]', material: null, materialSource: null, careInstructions: '[]',
        brand: null, size: null, season: '[]', tags: '[]', aiDescription: null,
        occasion: '[]', timesWorn: 0, lastWornAt: null, createdAt: Date.now(), updatedAt: Date.now(), tagImageUri: null,
      }],
      loading: false, error: null, refetch: vi.fn(),
    })

    renderPageWithReset(TryOn, 'tryon')

    await waitFor(() => expect(screen.getByText(/Select Items/)).toBeInTheDocument())
    screen.getByText(/Select Items/).click()

    await waitFor(() => expect(screen.getByRole('button', { name: /generate preview/i })).toBeInTheDocument())

    // Select an item
    screen.getByAltText('t-shirt').closest('button')?.click()

    // Verify item is selected (checkmark visible)
    await waitFor(() => expect(screen.getByText(/1\s*selected/).textContent).toMatch(/1/))

    // Trigger reset — should go back to step 1 with cleared selection
    act(() => { screen.getByTestId('reset-tryon').click() })
    await waitFor(() => expect(screen.getByText(/Select Items/)).toBeInTheDocument())
  })
})

describe('Closet — active tab reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.scrollTo = vi.fn()
  })

  it('renders closet reset button and accepts reset', async () => {
    const { Closet } = await import('../../src/pages/Closet')
    renderPageWithReset(Closet, 'closet')

    await waitFor(() => expect(screen.getByTestId('reset-closet')).toBeInTheDocument())

    act(() => { screen.getByTestId('reset-closet').click() })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})

describe('Outfits — active tab reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.scrollTo = vi.fn()
  })

  it('renders outfits reset button and accepts reset', async () => {
    const { Outfits } = await import('../../src/pages/Outfits')
    renderPageWithReset(Outfits, 'outfits')

    await waitFor(() => expect(screen.getByTestId('reset-outfits')).toBeInTheDocument())

    act(() => { screen.getByTestId('reset-outfits').click() })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})

describe('Settings — active tab reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.scrollTo = vi.fn()
    const store: Record<string, string> = {}
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value },
        removeItem: (key: string) => { delete store[key] },
        clear: () => { Object.keys(store).forEach(k => delete store[k]) },
        get length() { return Object.keys(store).length },
        key: (i: number) => Object.keys(store)[i] ?? null,
      } as Storage,
      writable: true,
      configurable: true,
    })
  })

  it('renders settings reset button and accepts reset', async () => {
    const { Settings } = await import('../../src/pages/Settings')
    renderPageWithReset(Settings, 'settings', { onLogout: vi.fn() })

    await waitFor(() => expect(screen.getByTestId('reset-settings')).toBeInTheDocument())

    act(() => { screen.getByTestId('reset-settings').click() })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })
})
