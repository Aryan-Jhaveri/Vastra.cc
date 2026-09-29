// #375 — the Settings "Log Out" button clears account-local localStorage
// through the real client helpers (api/client is NOT mocked here).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))
vi.mock('../../src/hooks/useInstallPrompt', () => ({
  useInstallPrompt: () => ({ canInstall: false, isInstalled: false, install: vi.fn() }),
}))
vi.mock('../../src/hooks/useSettings', () => ({
  useSettings: () => ({ settings: { handle: '', pushEnabled: false }, update: vi.fn().mockResolvedValue({}), loading: false, error: null }),
}))
vi.mock('../../src/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({ state: 'unsupported', subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest: vi.fn() }),
}))
vi.mock('../../src/hooks/useShopEnabled', () => ({ useShopEnabled: () => false }))
vi.mock('../../src/hooks/useBillingEnabled', () => ({ useBillingEnabled: () => false }))
vi.mock('../../src/api/share', () => ({ fetchMyShares: vi.fn().mockResolvedValue([]), deleteShare: vi.fn() }))
vi.mock('../../src/api/auth', () => ({
  getMe: vi.fn().mockResolvedValue({ email: 'a@b.c', name: 'A' }),
  patchMe: vi.fn(),
}))

import { Settings } from '../../src/pages/Settings'

const KEYS = [
  'closet:theme', 'closet:customPalettes', 'closet:customPaletteSlot', 'theme',
  'closet-pending-share', 'closet_onboarded', 'closet_walkedthrough',
]

describe('Settings — Log Out (#375)', () => {
  const assign = vi.fn()
  const originalLocation = window.location

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve({}), text: () => Promise.resolve('{}'),
      clone() { return this },
    }))
    Object.defineProperty(window, 'location', { writable: true, value: { ...originalLocation, assign, href: 'http://localhost/settings' } })
  })

  it('clears theme and per-account keys and resets to Brutalist light', async () => {
    localStorage.setItem('closet:theme', 'silk')
    localStorage.setItem('closet:customPalettes', JSON.stringify({
      1: { light: { primary: '#112233', secondary: '#fafafa', tertiary: '#333333' }, dark: { primary: '#aabbcc', secondary: '#101010', tertiary: '#dddddd' } },
    }))
    localStorage.setItem('closet:customPaletteSlot', '1')
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('closet-pending-share', 'abc')
    localStorage.setItem('closet_onboarded', 'true')
    localStorage.setItem('closet_walkedthrough', 'true')
    document.documentElement.classList.add('dark', 'custom-palette')

    render(<MemoryRouter><Settings /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /log out/i }))

    await waitFor(() => expect(assign).toHaveBeenCalled())
    for (const key of KEYS) expect(localStorage.getItem(key), key).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.classList.contains('custom-palette')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--color-paper')).toBe('#ffffff')

    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', { writable: true, value: originalLocation })
  })
})
