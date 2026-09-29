import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory stand-in for the settings table, keyed the same way (key + userId)
// so cross-user isolation is actually exercised rather than mocked away.
const store = new Map<string, string>()

vi.mock('../src/db/queries.js', () => ({
  getSetting: (key: string, userId: string) => store.get(`${userId}:${key}`) ?? null,
  setSetting: (key: string, value: string, userId: string) => { store.set(`${userId}:${key}`, value) },
  requireUserId: (userId: string) => {
    if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authenticated userId is required')
  },
}))

import { getSettings, updateSettings, parseServerLocation } from '../src/settings.js'

const USER = 'user-1'

beforeEach(() => store.clear())

describe('serverLocation opt-in', () => {
  it('is absent until the user explicitly saves one', () => {
    expect(getSettings(USER).serverLocation).toBeUndefined()
  })

  it('round-trips an enabled location', () => {
    updateSettings({ serverLocation: { enabled: true, lat: 51.5, lon: -0.12, name: 'London' } }, USER)
    expect(getSettings(USER).serverLocation).toEqual({ enabled: true, lat: 51.5, lon: -0.12, name: 'London' })
  })

  it('discards stored coordinates when disabled', () => {
    updateSettings({ serverLocation: { enabled: true, lat: 51.5, lon: -0.12, name: 'London' } }, USER)
    updateSettings({ serverLocation: { enabled: false } }, USER)

    const stored = store.get(`${USER}:serverLocation`)
    expect(stored).toBe('{"enabled":false}')
    expect(stored).not.toContain('51.5')
    expect(getSettings(USER).serverLocation).toEqual({ enabled: false })
  })

  it('leaves unrelated settings untouched', () => {
    updateSettings({ themeId: 'silk' }, USER)
    updateSettings({ serverLocation: { enabled: true, lat: 1, lon: 2, name: 'Here' } }, USER)
    expect(getSettings(USER).themeId).toBe('silk')
  })

  it('keeps one user\'s location invisible to another', () => {
    updateSettings({ serverLocation: { enabled: true, lat: 51.5, lon: -0.12, name: 'London' } }, USER)
    expect(getSettings('user-2').serverLocation).toBeUndefined()
  })

  it('reads as disabled when the stored value is corrupt', () => {
    store.set(`${USER}:serverLocation`, '{not json')
    expect(getSettings(USER).serverLocation).toEqual({ enabled: false })

    store.set(`${USER}:serverLocation`, '{"enabled":true,"lat":"north"}')
    expect(getSettings(USER).serverLocation).toEqual({ enabled: false })
  })
})

describe('parseServerLocation', () => {
  it('accepts zero coordinates', () => {
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 0, name: 'Null Island' }))
      .toEqual({ enabled: true, lat: 0, lon: 0, name: 'Null Island' })
  })

  it('keeps a valid ISO country code and omits it when absent', () => {
    expect(parseServerLocation({ enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' }))
      .toEqual({ enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' })
    expect(parseServerLocation({ enabled: true, lat: 1, lon: 1, name: 'x' })).not.toHaveProperty('countryCode')
  })

  it('rejects partial, out-of-range and non-finite input', () => {
    expect(parseServerLocation({ enabled: true, lat: 51.5, name: 'No lon' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 91, lon: 0, name: 'Off world' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 181, name: 'Off world' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: NaN, lon: 0, name: 'NaN' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: Infinity, lon: 0, name: 'Inf' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 0, name: 'x'.repeat(201) })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 0, name: '' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 0, name: 'x', countryCode: 'usa' })).toBeNull()
    expect(parseServerLocation({ enabled: true, lat: 0, lon: 0, name: 'x', countryCode: 7 })).toBeNull()
    expect(parseServerLocation({ enabled: 'yes', lat: 0, lon: 0, name: 'x' })).toBeNull()
    expect(parseServerLocation(null)).toBeNull()
    expect(parseServerLocation('enabled')).toBeNull()
  })
})

describe('shopGender (Style & Show → Shop for)', () => {
  it('is absent until the user picks one', () => {
    expect(getSettings(USER).shopGender).toBeUndefined()
  })

  it('round-trips each valid value and is per user', () => {
    for (const g of ['female', 'male', 'any'] as const) {
      updateSettings({ shopGender: g }, USER)
      expect(getSettings(USER).shopGender).toBe(g)
    }
    expect(getSettings('user-2').shopGender).toBeUndefined()
  })

  it('ignores invalid values, stored or patched', () => {
    updateSettings({ shopGender: 'female' }, USER)
    updateSettings({ shopGender: 'Women' as never }, USER)
    expect(getSettings(USER).shopGender).toBe('female')
    store.set(`${USER}:shopGender`, 'garbage')
    expect(getSettings(USER).shopGender).toBeUndefined()
  })
})
