import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db/queries.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  requireUserId: (userId: string) => {
    if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authenticated userId is required')
  },
}))

import { getSetting, setSetting } from '../src/db/queries.js'
import { getSettings, updateSettings } from '../src/settings.js'

describe('settings theme prefs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns themeId and colorScheme for user', () => {
    vi.mocked(getSetting).mockImplementation((key, userId) => {
      if (userId !== 'user-1') return null
      if (key === 'themeId') return 'silk'
      if (key === 'colorScheme') return 'dark'
      return null
    })

    expect(getSettings('user-1')).toEqual({ themeId: 'silk', colorScheme: 'dark' })
  })

  it('ignores invalid themeId and colorScheme', () => {
    vi.mocked(getSetting).mockImplementation((key) => {
      if (key === 'themeId') return 'invalid'
      if (key === 'colorScheme') return 'sepia'
      return null
    })

    expect(getSettings('user-1')).toEqual({})
  })

  it('persists valid theme prefs', () => {
    vi.mocked(getSetting).mockReturnValue(null)

    updateSettings({ themeId: 'atelier', colorScheme: 'light' }, 'user-1')

    expect(setSetting).toHaveBeenCalledWith('themeId', 'atelier', 'user-1')
    expect(setSetting).toHaveBeenCalledWith('colorScheme', 'light', 'user-1')
  })
})
