import { getSetting, setSetting, requireUserId } from './db/queries.js'
import { VALID_THEME_IDS, type ThemeId, isValidThemeId } from './constants/themes.js'
import { CATEGORY_KEYS, isValidCategory, type Category } from './constants/categories.js'

export { isValidThemeId }
export type { ThemeId } from './constants/themes.js'
export { VALID_THEME_IDS }

export type ColorScheme = 'dark' | 'light'

export interface ThemeModeColors {
  primary: string
  secondary: string
  tertiary: string
}

export interface CustomThemePalette {
  light: ThemeModeColors
  dark: ThemeModeColors
}

export type CustomPaletteSlot = 1 | 2 | 3 | 4
export type CustomThemePalettes = Partial<Record<CustomPaletteSlot, CustomThemePalette>>

export function isValidCustomPaletteSlot(value: unknown): value is CustomPaletteSlot {
  return value === 1 || value === 2 || value === 3 || value === 4
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function isValidThemeModeColors(value: unknown): value is ThemeModeColors {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const colors = value as Record<string, unknown>
  const keys = Object.keys(colors)
  return keys.length === 3 && keys.includes('primary') && keys.includes('secondary') && keys.includes('tertiary') &&
    typeof colors.primary === 'string' && HEX_COLOR_PATTERN.test(colors.primary) &&
    typeof colors.secondary === 'string' && HEX_COLOR_PATTERN.test(colors.secondary) &&
    typeof colors.tertiary === 'string' && HEX_COLOR_PATTERN.test(colors.tertiary)
}

export function isValidCustomThemePalettes(value: unknown): value is CustomThemePalettes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const palettes = value as Record<string, unknown>
  for (const [themeId, palette] of Object.entries(palettes)) {
    if (!/^[1-4]$/.test(themeId) || typeof palette !== 'object' || palette === null || Array.isArray(palette)) return false
    const modes = palette as Record<string, unknown>
    if (Object.keys(modes).length !== 2 || !('light' in modes) || !('dark' in modes)) return false
    if (!isValidThemeModeColors(modes.light) || !isValidThemeModeColors(modes.dark)) return false
  }
  return true
}

function parseStoredCustomThemePalettes(stored: string): CustomThemePalettes | undefined {
  try {
    const parsed: unknown = JSON.parse(stored)
    return isValidCustomThemePalettes(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Opt-in, explicitly saved by the user so server-side features (scheduled
 *  suggestions, reminders) have a location without a live browser. Absent or
 *  malformed means disabled — never fall back to a last-known location. */
export type ServerLocation =
  | { enabled: false }
  | { enabled: true; lat: number; lon: number; name: string; countryCode?: string }

/** Who the Related shop row shops for (#324). `any` (the default) sends no
 *  gender filter to Shopify; `female` / `male` map to the taxonomy's
 *  "Target gender" values, always alongside Unisex. Opt-in, user-set only. */
export type ShopGender = 'female' | 'male' | 'any'
export const SHOP_GENDERS: readonly ShopGender[] = ['female', 'male', 'any']

export function isValidShopGender(v: unknown): v is ShopGender {
  return typeof v === 'string' && (SHOP_GENDERS as readonly string[]).includes(v)
}

/** The user's own size per clothing category (#329). Free text, e.g.
 *  `{ tops: 'M', bottoms: '32 × 30', shoes: 'US 10' }`. Personal data: never
 *  sent to share payloads, Discover, analytics, Jev or stores — the only
 *  model that reads it is the Ask agent (`get_my_sizes`), and only while
 *  `sizesAgentContext` is on. */
export type UserSizes = Partial<Record<Category, string>>

/** A merge patch for `userSizes`: a string sets that category (trimmed), an
 *  empty string or null removes it, absent categories are left alone. */
export type UserSizesPatch = Partial<Record<Category, string | null>>

export const MAX_SIZE_LENGTH = 30

export interface AppSettings {
  navWidth?: number
  themeId?: ThemeId
  colorScheme?: ColorScheme
  customPalettes?: CustomThemePalettes
  customPaletteSlot?: CustomPaletteSlot
  serverLocation?: ServerLocation
  shopGender?: ShopGender
  userSizes?: UserSizes
  /** Absent means the default: on. Read it through `isSizesAgentContextEnabled`. */
  sizesAgentContext?: boolean
}

/** What `updateSettings` accepts: like AppSettings, but sizes are a merge patch. */
export type SettingsPatch = Omit<Partial<AppSettings>, 'userSizes' | 'customPalettes' | 'customPaletteSlot'> & {
  userSizes?: UserSizesPatch
  customPalettes?: CustomThemePalettes
  customPaletteSlot?: CustomPaletteSlot | null
}

const MAX_LOCATION_NAME = 200

export function parseServerLocation(raw: unknown): ServerLocation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  if (v.enabled === false) return { enabled: false }
  if (v.enabled !== true) return null
  const { lat, lon, name } = v
  // Reject partial coordinate pairs, NaN/Infinity and out-of-range values.
  // 0 is a legitimate coordinate, so check finiteness, not truthiness.
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LOCATION_NAME) return null
  // ISO 3166-1 alpha-2, from geocoding. Optional: browser geolocation has none.
  const { countryCode } = v
  if (countryCode !== undefined && (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode))) return null
  return { enabled: true, lat, lon, name, ...(countryCode ? { countryCode } : {}) }
}

export function isValidColorScheme(v: string): v is ColorScheme {
  return v === 'dark' || v === 'light'
}

/** Own-key check: `isValidCategory` uses `in`, which also accepts inherited
 *  keys like `constructor` / `__proto__`. Stored keys must be real categories. */
function isSizeCategory(key: string): key is Category {
  return (CATEGORY_KEYS as readonly string[]).includes(key) && isValidCategory(key)
}

/**
 * Validate a `userSizes` merge patch from an untrusted caller (route body,
 * agent tool). Returns null — reject, don't ignore — when it isn't a plain
 * object, names a key that isn't a category, or holds a value that isn't a
 * string/null or is longer than MAX_SIZE_LENGTH after trimming. Values come
 * back trimmed; '' and null both mean "remove this category".
 */
export function parseUserSizesPatch(raw: unknown): UserSizesPatch | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: UserSizesPatch = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSizeCategory(key)) return null
    if (value === null) { out[key] = null; continue }
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (trimmed.length > MAX_SIZE_LENGTH) return null
    out[key] = trimmed
  }
  return out
}

/** Read stored sizes. Stored JSON is untrusted: unparseable → empty, and any
 *  entry that isn't a valid category with a 1–30 char string is dropped. */
export function parseStoredUserSizes(stored: string | null): UserSizes {
  if (!stored) return {}
  let raw: unknown
  try { raw = JSON.parse(stored) } catch { return {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: UserSizes = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSizeCategory(key) || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_SIZE_LENGTH) continue
    out[key] = trimmed
  }
  return out
}

/** Apply a validated merge patch to the current sizes. */
export function mergeUserSizes(current: UserSizes, patch: UserSizesPatch): UserSizes {
  const next: UserSizes = { ...current }
  for (const [key, value] of Object.entries(patch) as [Category, string | null][]) {
    if (value === null || value === '') delete next[key]
    else next[key] = value
  }
  return next
}

/** `sizesAgentContext` defaults to on: only an explicit `false` disables it. */
export function isSizesAgentContextEnabled(settings: Pick<AppSettings, 'sizesAgentContext'>): boolean {
  return settings.sizesAgentContext !== false
}

export function getSettings(userId: string): AppSettings {
  // Required and validated at runtime: settings are personal data (sizes,
  // saved location), and an omitted id must never read an unscoped row.
  requireUserId(userId)
  const navWidth = getSetting('navWidth', userId)
  const themeId = getSetting('themeId', userId)
  const colorScheme = getSetting('colorScheme', userId)
  const customPalettes = getSetting('customPalettes', userId)
  const customPaletteSlot = getSetting('customPaletteSlot', userId)
  const serverLocation = getSetting('serverLocation', userId)
  const shopGender = getSetting('shopGender', userId)
  const userSizes = getSetting('userSizes', userId)
  const sizesAgentContext = getSetting('sizesAgentContext', userId)
  const result: AppSettings = {}
  if (shopGender && isValidShopGender(shopGender)) result.shopGender = shopGender
  if (navWidth) result.navWidth = parseInt(navWidth, 10) || undefined
  if (themeId && isValidThemeId(themeId)) result.themeId = themeId
  if (colorScheme && isValidColorScheme(colorScheme)) result.colorScheme = colorScheme
  if (customPalettes) {
    const parsed = parseStoredCustomThemePalettes(customPalettes)
    if (parsed && Object.keys(parsed).length > 0) result.customPalettes = parsed
  }
  if (customPaletteSlot && /^[1-4]$/.test(customPaletteSlot)) {
    const slot = Number(customPaletteSlot) as CustomPaletteSlot
    if (result.customPalettes?.[slot]) result.customPaletteSlot = slot
  }
  // Stored JSON is treated as untrusted: anything unparseable reads as
  // disabled rather than throwing on an unrelated settings fetch.
  if (serverLocation) {
    let parsed: ServerLocation | null = null
    try { parsed = parseServerLocation(JSON.parse(serverLocation)) } catch { parsed = null }
    result.serverLocation = parsed ?? { enabled: false }
  }
  // Same rule for sizes: corrupt JSON reads as no sizes.
  if (userSizes !== null) result.userSizes = parseStoredUserSizes(userSizes)
  if (sizesAgentContext === 'true') result.sizesAgentContext = true
  else if (sizesAgentContext === 'false') result.sizesAgentContext = false
  return result
}

export function updateSettings(patch: SettingsPatch, userId: string): AppSettings {
  requireUserId(userId)

  if (patch.navWidth !== undefined) {
    setSetting('navWidth', String(patch.navWidth), userId)
  }
  if (patch.themeId !== undefined) {
    if (patch.themeId && isValidThemeId(patch.themeId)) {
      setSetting('themeId', patch.themeId, userId)
    }
  }
  if (patch.colorScheme !== undefined) {
    if (patch.colorScheme && isValidColorScheme(patch.colorScheme)) {
      setSetting('colorScheme', patch.colorScheme, userId)
    }
  }

  if (patch.customPalettes !== undefined) {
    if (!isValidCustomThemePalettes(patch.customPalettes)) {
      throw new Error('Invalid customPalettes')
    }
    setSetting('customPalettes', JSON.stringify(patch.customPalettes), userId)
  }

  if (patch.customPaletteSlot !== undefined) {
    if (patch.customPaletteSlot !== null && !isValidCustomPaletteSlot(patch.customPaletteSlot)) {
      throw new Error('Invalid customPaletteSlot')
    }
    if (patch.customPaletteSlot !== null) {
      const availablePalettes = patch.customPalettes ?? getSettings(userId).customPalettes
      if (!availablePalettes?.[patch.customPaletteSlot]) throw new Error('Custom palette slot is empty')
    }
    setSetting('customPaletteSlot', patch.customPaletteSlot === null ? '' : String(patch.customPaletteSlot), userId)
  }

  if (patch.shopGender !== undefined && isValidShopGender(patch.shopGender)) {
    setSetting('shopGender', patch.shopGender, userId)
  }

  if (patch.serverLocation !== undefined) {
    const parsed = parseServerLocation(patch.serverLocation)
    if (parsed) {
      // Disabling overwrites the row, so stored coordinates are discarded
      // rather than lingering behind a false flag.
      setSetting('serverLocation', JSON.stringify(parsed), userId)
    }
  }

  if (patch.userSizes !== undefined) {
    // Re-validated here, not just in the route: the agent tool writes through
    // this too, and an invalid patch must fail loudly rather than half-apply.
    const sizesPatch = parseUserSizesPatch(patch.userSizes)
    if (!sizesPatch) throw new Error('Invalid userSizes')
    const current = parseStoredUserSizes(getSetting('userSizes', userId))
    setSetting('userSizes', JSON.stringify(mergeUserSizes(current, sizesPatch)), userId)
  }

  if (patch.sizesAgentContext !== undefined) {
    if (typeof patch.sizesAgentContext !== 'boolean') throw new Error('Invalid sizesAgentContext')
    setSetting('sizesAgentContext', String(patch.sizesAgentContext), userId)
  }

  return getSettings(userId)
}
