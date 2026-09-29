import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  useLocation: () => ({ lat: null, lon: null, name: '' }),
}))

vi.mock('../../src/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: { handle: '', telegramChatId: null, pushEnabled: false },
    update: vi.fn(),
    loading: false,
    error: null,
  }),
}))

vi.mock('../../src/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ enabled: false, loading: false, toggle: vi.fn() }),
}))

vi.mock('../../src/api/share', () => ({
  fetchMyShares: vi.fn().mockResolvedValue([]),
  deleteShare: vi.fn(),
}))

const mockApiFetch = vi.fn()
vi.mock('../../src/api/client', () => ({
  apiFetch: mockApiFetch,
  apiFetchJSON: vi.fn().mockResolvedValue({ userId: 'u1', email: '', name: null }),
  clearSessionState: vi.fn(),
  purgePrivateState: vi.fn(),
}))

let Settings: typeof import('../../src/pages/Settings').Settings

beforeAll(async () => {
  const mod = await import('../../src/pages/Settings')
  Settings = mod.Settings
})

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings onLogout={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('Settings — Profile section', () => {
  it('renders the Profile section header', () => {
    renderSettings()
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('displays user email after fetch', async () => {
    const { apiFetchJSON } = await import('../../src/api/client')
    vi.mocked(apiFetchJSON).mockResolvedValueOnce({
      userId: 'u1',
      email: 'test@test.com',
      name: 'Alice',
    })
    renderSettings()
    await waitFor(() => {
      expect(screen.getByText('test@test.com')).toBeInTheDocument()
    })
  })

  it('displays user name when set', async () => {
    const { apiFetchJSON } = await import('../../src/api/client')
    vi.mocked(apiFetchJSON).mockResolvedValueOnce({
      userId: 'u1',
      email: 'test@test.com',
      name: 'Alice',
    })
    renderSettings()
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument()
    })
  })

  it('shows dash for null name', async () => {
    const { apiFetchJSON } = await import('../../src/api/client')
    vi.mocked(apiFetchJSON).mockResolvedValueOnce({
      userId: 'u1',
      email: 'test@test.com',
      name: null,
    })
    renderSettings()
    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument()
    })
  })
})
