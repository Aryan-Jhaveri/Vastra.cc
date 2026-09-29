import { fetchSettings } from '../api/settings'
import { applyAccountThemePreference, applyLocalThemePreference } from './theme'

/**
 * Decide the theme after sign-in (#375).
 *
 * Settings loaded → the account is the source of truth, even when it has
 * nothing saved: that means the default theme, not whatever the previous
 * account left in localStorage. Only a failed request (offline, server down)
 * keeps the local copy as a fallback.
 */
export async function syncThemeFromAccount(): Promise<void> {
  let s: Awaited<ReturnType<typeof fetchSettings>>
  try {
    s = await fetchSettings()
  } catch {
    applyLocalThemePreference()
    return
  }
  applyAccountThemePreference(s.themeId, s.colorScheme, s.customPalettes, s.customPaletteSlot)
}
