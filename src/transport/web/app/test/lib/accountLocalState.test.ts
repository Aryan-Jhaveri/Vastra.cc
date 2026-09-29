// #375 — account-local state must not leak to the next account on this
// browser after sign-out or a rejected session.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsApi = vi.hoisted(() => ({ fetchSettings: vi.fn() }))
vi.mock('../../src/api/settings', () => settingsApi)

import { apiFetch, clearSessionState, purgePrivateState } from '../../src/api/client'
import { applyAccountThemePreference, type CustomThemePalette } from '../../src/lib/theme'
import { syncThemeFromAccount } from '../../src/lib/themeSync'

const palette: CustomThemePalette = {
  light: { primary: '#112233', secondary: '#fafafa', tertiary: '#333333' },
  dark: { primary: '#aabbcc', secondary: '#101010', tertiary: '#dddddd' },
}
const html = document.documentElement
const css = (name: string) => html.style.getPropertyValue(name)

const ACCOUNT_KEYS = [
  'closet:theme', 'closet:customPalettes', 'closet:customPaletteSlot', 'theme',
  'closet-pending-share', 'closet_onboarded', 'closet_walkedthrough', 'closet-location',
]

/** Leave behind everything a previous account (dark Silk + custom slot 2) would. */
function seedPreviousAccount(): void {
  localStorage.setItem('closet:theme', 'silk')
  localStorage.setItem('closet:customPalettes', JSON.stringify({ 2: palette }))
  localStorage.setItem('closet:customPaletteSlot', '2')
  localStorage.setItem('theme', 'dark')
  localStorage.setItem('closet-pending-share', 'share-of-prev-user')
  localStorage.setItem('closet_onboarded', 'true')
  localStorage.setItem('closet_walkedthrough', 'true')
  localStorage.setItem('closet-location', JSON.stringify({ lat: 1, lon: 2, name: 'X' }))
  html.classList.add('dark', 'custom-palette')
  html.style.setProperty('--color-paper', '#101010')
}

function expectBrutalistLight(): void {
  expect(html.classList.contains('dark')).toBe(false)
  expect(html.classList.contains('custom-palette')).toBe(false)
  expect(css('--color-paper')).toBe('#ffffff')
  expect(css('--color-ink')).toBe('#0a0a0a')
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  html.removeAttribute('style')
  html.className = ''
})

describe('sign-out / rejected session clears account-local state', () => {
  it('clearSessionState (logout path) removes every per-account key and resets the theme', () => {
    seedPreviousAccount()
    clearSessionState()
    for (const key of ACCOUNT_KEYS) expect(localStorage.getItem(key), key).toBeNull()
    expectBrutalistLight()
  })

  it('keeps device-level keys and the cross-tab sign-in ping', () => {
    localStorage.setItem('closet:swipe-hint-dismissed', '1')
    localStorage.setItem('closet-session-changed', '123')
    purgePrivateState()
    expect(localStorage.getItem('closet:swipe-hint-dismissed')).toBe('1')
    expect(localStorage.getItem('closet-session-changed')).toBe('123')
  })

  it('a rejected session (401 from apiFetch) clears them the same way', async () => {
    const originalLocation = window.location
    Object.defineProperty(window, 'location', { writable: true, value: { href: 'about:blank' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }))
    try {
      seedPreviousAccount()
      const res = await apiFetch('/api/items')
      expect(res.status).toBe(401)
      for (const key of ACCOUNT_KEYS) expect(localStorage.getItem(key), key).toBeNull()
      expectBrutalistLight()
      expect((window.location as { href: string }).href).toBe('/')
    } finally {
      vi.unstubAllGlobals()
      Object.defineProperty(window, 'location', { writable: true, value: originalLocation })
    }
  })
})

describe('syncThemeFromAccount', () => {
  it('account with no saved prefs → Brutalist light, ignoring the previous account’s localStorage', async () => {
    seedPreviousAccount()
    settingsApi.fetchSettings.mockResolvedValue({})
    await syncThemeFromAccount()
    expectBrutalistLight()
    expect(localStorage.getItem('closet:theme')).toBe('brutalist')
    expect(localStorage.getItem('theme')).toBe('light')
    expect(localStorage.getItem('closet:customPaletteSlot')).toBeNull()
  })

  it('settings request fails → falls back to the local theme', async () => {
    localStorage.setItem('closet:theme', 'silk')
    localStorage.setItem('theme', 'dark')
    settingsApi.fetchSettings.mockRejectedValue(new TypeError('offline'))
    await syncThemeFromAccount()
    expect(html.classList.contains('dark')).toBe(true)
    expect(css('--color-paper')).toBe('#0c1020') // Silk dark paper
  })

  it('applies saved account prefs', async () => {
    settingsApi.fetchSettings.mockResolvedValue({ themeId: 'atelier', colorScheme: 'dark' })
    await syncThemeFromAccount()
    expect(html.classList.contains('dark')).toBe(true)
    expect(css('--color-paper')).toBe('#1b1c19')
  })
})

describe('applyAccountThemePreference — missing fields mean the default', () => {
  it('only themeId saved → color scheme is light, not inherited from localStorage', () => {
    localStorage.setItem('theme', 'dark')
    applyAccountThemePreference('atelier')
    expect(html.classList.contains('dark')).toBe(false)
    expect(css('--color-paper')).toBe('#fbf9f4')
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('only colorScheme saved → theme is Brutalist, not inherited from localStorage', () => {
    localStorage.setItem('closet:theme', 'silk')
    applyAccountThemePreference(undefined, 'dark')
    expect(css('--color-paper')).toBe('#0a0a0a') // Brutalist dark paper
    expect(localStorage.getItem('closet:theme')).toBe('brutalist')
  })
})
