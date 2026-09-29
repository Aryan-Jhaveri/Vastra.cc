import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const store: Record<string, string> = {}
beforeAll(() => {
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

// Hosted UI (billing, legal) is tested under test/hosted/; here the hosted
// index is the open-source stub, so this file runs in both repos.
vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))
vi.mock('../../src/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ canInstall: false, isInstalled: false, install: vi.fn() }),
}))
vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({ location: null, geocode: vi.fn(), clearLocation: vi.fn() }),
}))
const settingsMock = vi.hoisted(() => ({
  update: vi.fn().mockResolvedValue({}),
  settings: { handle: '', telegramChatId: null, pushEnabled: false } as Record<string, unknown>,
  loading: false,
}))
vi.mock('../../src/hooks/useSettings', () => ({
  useSettings: () => ({ settings: settingsMock.settings, update: settingsMock.update, loading: settingsMock.loading, error: null }),
}))
vi.mock('../../src/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ state: 'unsupported', subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest: vi.fn() }),
}))
vi.mock('../../src/api/share', () => ({
  fetchMyShares: vi.fn().mockResolvedValue([]),
  deleteShare: vi.fn(),
}))
vi.mock('../../src/api/client', () => ({
  apiFetch: vi.fn(),
  apiFetchJSON: vi.fn().mockResolvedValue({ userId: 'u1', email: '', name: null }),
  clearSessionState: vi.fn(),
  purgePrivateState: vi.fn(),
}))
vi.mock('../../src/api/account', () => ({
  deleteAccount: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/api/auth', () => ({
  getMe: vi.fn().mockResolvedValue({ email: 'test@test.com', name: 'Test' }),
  patchMe: vi.fn(),
}))

const shopEnabledMock = vi.hoisted(() => ({ value: true }))
vi.mock('../../src/hooks/useShopEnabled', () => ({
  useShopEnabled: () => shopEnabledMock.value,
}))

// #315 — billing section is gated on billingEnabled. Default true so the
// existing (non-billing) assertions render Settings as before without a
// real /api/auth/status fetch.
vi.mock('../../src/hooks/useBillingEnabled', () => ({
  useBillingEnabled: () => true,
}))

window.HTMLElement.prototype.scrollIntoView = vi.fn()

let Settings: typeof import('../../src/pages/Settings').Settings
beforeAll(async () => {
  Settings = (await import('../../src/pages/Settings')).Settings
})

function renderSettingsTree() {
  return (
    <MemoryRouter>
      <Settings onLogout={vi.fn()} />
    </MemoryRouter>
  )
}

function renderSettings() {
  return render(renderSettingsTree())
}

describe('Settings — Style & shopping section (#329)', () => {
  it('sits between Location and Push Notifications and holds Sizes, Liked items and Shop for', () => {
    renderSettings()
    const location = screen.getByText('Location')
    const heading = screen.getByText(/Style & shopping/)
    const sizes = screen.getByRole('button', { name: /^Sizes/ })
    const liked = screen.getByRole('button', { name: /liked items/i })
    const shopFor = screen.getByRole('radiogroup', { name: 'Shop for' })
    const push = screen.getByText('Push Notifications')
    const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(location, heading)).toBe(true)
    expect(follows(heading, sizes)).toBe(true)
    expect(follows(sizes, liked)).toBe(true)
    expect(follows(liked, shopFor)).toBe(true)
    expect(follows(shopFor, push)).toBe(true)
    expect(screen.getByText('New')).toBeInTheDocument()
    // The old top-of-page heading is gone (reused, not duplicated).
    expect(screen.queryByText('Style & Shop')).not.toBeInTheDocument()
  })

  it('shows a sizes summary in category order', () => {
    const prev = settingsMock.settings.userSizes
    settingsMock.settings.userSizes = { shoes: 'US 10', tops: 'M', bottoms: '32×30' }
    try {
      renderSettings()
      expect(screen.getByText('Tops M · Bottoms 32×30 · Shoes US 10')).toBeInTheDocument()
    } finally {
      settingsMock.settings.userSizes = prev
    }
  })

  it('prompts to add sizes when none are set', () => {
    renderSettings()
    expect(screen.getByText('Add your sizes')).toBeInTheDocument()
  })

  it('gives Liked items the same two-line row as Sizes, so they are the same height', () => {
    renderSettings()
    const sizes = screen.getByRole('button', { name: /^Sizes/ })
    const liked = screen.getByRole('button', { name: /liked items/i })
    expect(liked.className).toBe(sizes.className)
    expect(screen.getByText('Saved from shop results')).toBeInTheDocument()
    const lines = (b: HTMLElement) => Array.from(b.querySelectorAll('p')).map(p => p.className)
    expect(lines(liked)).toHaveLength(2)
    expect(lines(liked)[1]).toBe(lines(sizes)[1])
  })

  it('keeps the Sizes row but hides Liked items and Shop for when SHOP_ROW_ENABLED is off', () => {
    shopEnabledMock.value = false
    try {
      renderSettings()
      expect(screen.getByText(/Style & shopping/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Sizes/ })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /liked items/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('radiogroup', { name: 'Shop for' })).not.toBeInTheDocument()
      expect(screen.getByText('Location')).toBeInTheDocument()
    } finally {
      shopEnabledMock.value = true
    }
  })

  it('the Sizes row navigates to /settings/sizes', async () => {
    const { Routes, Route } = await import('react-router')
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/settings" element={<Settings onLogout={vi.fn()} />} />
          <Route path="/settings/sizes" element={<p>sizes page</p>} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Sizes/ }))
    expect(await screen.findByText('sizes page')).toBeInTheDocument()
  })
})

describe('Settings — Shop for', () => {
  it('defaults to Everyone and saves the picked gender', async () => {
    settingsMock.update.mockClear()
    renderSettings()
    const group = screen.getByRole('radiogroup', { name: 'Shop for' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Everyone' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByRole('radio', { name: 'Women' }))
    await waitFor(() => expect(settingsMock.update).toHaveBeenCalledWith({ shopGender: 'female' }))
  })

  it('shows the saved value and does not re-save it', () => {
    settingsMock.update.mockClear()
    settingsMock.settings = { ...settingsMock.settings, shopGender: 'male' }
    renderSettings()
    expect(screen.getByRole('radio', { name: 'Men' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Men' }))
    expect(settingsMock.update).not.toHaveBeenCalled()
    settingsMock.settings = { handle: '', telegramChatId: null, pushEnabled: false }
  })

  // #335 — no default highlighted while settings load, so a saved value never
  // flickers in over "Everyone".
  it('highlights nothing while settings are loading, then the saved value', () => {
    settingsMock.update.mockClear()
    settingsMock.loading = true
    settingsMock.settings = { ...settingsMock.settings, shopGender: 'female' }
    const { rerender } = renderSettings()
    for (const radio of screen.getAllByRole('radio')) {
      if (radio.closest('[aria-label="Shop for"]')) {
        expect(radio).toHaveAttribute('aria-checked', 'false')
        expect(radio).toBeDisabled()
      }
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone' }))
    expect(settingsMock.update).not.toHaveBeenCalled()

    settingsMock.loading = false
    rerender(renderSettingsTree())
    expect(screen.getByRole('radio', { name: 'Women' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Everyone' })).toHaveAttribute('aria-checked', 'false')
    settingsMock.settings = { handle: '', telegramChatId: null, pushEnabled: false }
  })
})

// The Legal section is hosted UI (vastra.cc's own policies): test/hosted/pages/Settings.test.tsx.
describe('Settings — hosted sections', () => {
  it('renders no Billing or Legal section from the open-source hosted stub', () => {
    renderSettings()
    expect(screen.queryByText('Billing')).toBeNull()
    expect(screen.queryByText('Legal')).toBeNull()
  })
})

describe('Settings — Navigation', () => {
  it('renders Guide navigation row in Prototype section', () => {
    renderSettings()

    const guideButtons = screen.getAllByRole('button').filter(btn => btn.textContent === 'Guide')
    expect(guideButtons.length).toBeGreaterThan(0)
  })

  it('renders Guide navigation row in About section', () => {
    renderSettings()

    const aboutSection = screen.getByText('About').parentElement
    expect(aboutSection).toBeInTheDocument()
  })

  it('renders Meet the team navigation row', () => {
    renderSettings()

    expect(screen.getByText('Meet the team')).toBeInTheDocument()
  })
})

describe('Settings — Delete collapsible row', () => {
  // The Delete row only renders once getMe() resolves to a non-self email,
  // and the row is collapsed by default — expand it before each test.
  async function expandDeleteRow() {
    const deleteRow = await screen.findByRole('button', { name: 'Delete' })
    fireEvent.click(deleteRow)
  }

  it('renders the collapsible row with a Delete Account button inside', async () => {
    renderSettings()
    await expandDeleteRow()

    expect(screen.getByRole('button', { name: 'Delete Account' })).toBeInTheDocument()
  })

  it('shows confirmation when Delete Account is clicked', async () => {
    renderSettings()
    await expandDeleteRow()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))

    expect(screen.getByText(/permanently delete your account/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Yes, delete my account/i })).toBeInTheDocument()
  })

  it('hides confirmation when Cancel is clicked', async () => {
    renderSettings()
    await expandDeleteRow()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    expect(screen.getByText(/permanently delete your account/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/permanently delete your account/i)).toBeNull()
  })

  it('calls deleteAccount API when confirmed', async () => {
    const { deleteAccount } = await import('../../src/api/account')
    renderSettings()
    await expandDeleteRow()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }))
    fireEvent.click(screen.getByRole('button', { name: /Yes, delete my account/i }))

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalled()
    })
  })
})

describe('Settings — Instance (#315)', () => {
  it('shows the Instance row only to an admin', async () => {
    const { getMe } = await import('../../src/api/auth')
    vi.mocked(getMe).mockResolvedValueOnce({ userId: 'u1', email: 'test@test.com', name: 'Test', isAdmin: false })
    const plain = renderSettings()
    await waitFor(() => expect(getMe).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /configuration/i })).not.toBeInTheDocument()
    plain.unmount()

    vi.mocked(getMe).mockResolvedValueOnce({ userId: 'u1', email: 'test@test.com', name: 'Test', isAdmin: true })
    renderSettings()
    expect(await screen.findByRole('button', { name: /configuration/i })).toBeInTheDocument()
  })
})

describe('Settings — About version (v2.0)', () => {
  it('shows Vastra with the version from package.json', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    // Frontend tests run from the app directory.
    const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    expect(version).toBe('2.0.0')
    renderSettings()
    expect(screen.getByTestId('app-version')).toHaveTextContent(`v${version}`)
    expect(screen.getByText('Vastra')).toBeInTheDocument()
    expect(screen.queryByText('My Closet')).not.toBeInTheDocument()
  })
})
