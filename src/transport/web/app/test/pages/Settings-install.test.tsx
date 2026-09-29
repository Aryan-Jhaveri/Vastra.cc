import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

// localStorage stub must be ready before Settings renders
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

// Mock useInstallPrompt
const mockUseInstallPrompt = vi.fn()
vi.mock('../../src/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => mockUseInstallPrompt(),
}))

vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({ lat: null, lon: null, name: '' }),
}))

vi.mock('../../src/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      handle: '',
      telegramChatId: null,
      pushEnabled: false,
    },
    update: vi.fn(),
    loading: false,
    error: null,
  }),
}))

vi.mock('../../src/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({
    enabled: false,
    loading: false,
    toggle: vi.fn(),
  }),
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

describe('Settings — Install section', () => {
  it('shows install button when canInstall is true', () => {
    mockUseInstallPrompt.mockReturnValue({
      canInstall: true,
      isInstalled: false,
      install: vi.fn(),
    })
    renderSettings()
    expect(screen.getByText('Install App')).toBeInTheDocument()
  })

  it('shows Installed when already installed', () => {
    mockUseInstallPrompt.mockReturnValue({
      canInstall: false,
      isInstalled: true,
      install: vi.fn(),
    })
    renderSettings()
    expect(screen.getByText('Installed')).toBeInTheDocument()
  })

  it('shows no App section when not installed and cannot install (non-iOS)', () => {
    mockUseInstallPrompt.mockReturnValue({
      canInstall: false,
      isInstalled: false,
      install: vi.fn(),
    })
    renderSettings()
    expect(screen.queryByText('Install App')).not.toBeInTheDocument()
    expect(screen.queryByText('Installed')).not.toBeInTheDocument()
  })

  it('shows iOS install instructions on iPhone when not installed', () => {
    const origUserAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      configurable: true,
      writable: true,
    })
    mockUseInstallPrompt.mockReturnValue({
      canInstall: false,
      isInstalled: false,
      install: vi.fn(),
    })
    renderSettings()
    expect(screen.getByText('Install App')).toBeInTheDocument()
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument()
    Object.defineProperty(navigator, 'userAgent', { value: origUserAgent, configurable: true, writable: true })
  })
})
