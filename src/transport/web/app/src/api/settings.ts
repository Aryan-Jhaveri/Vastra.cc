import { apiFetchJSON } from './client'

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

export type ServerLocation =
  | { enabled: false }
  | { enabled: true; lat: number; lon: number; name: string; countryCode?: string }

/** Who the Related shop row shops for; `any` sends no gender filter. */
export type ShopGender = 'female' | 'male' | 'any'

/** The user's own size per clothing category (#329), e.g. { tops: 'M' }. */
export type UserSizes = Partial<Record<string, string>>

export interface AppSettings {
  navWidth?: number
  themeId?: string
  colorScheme?: ColorScheme
  customPalettes?: CustomThemePalettes
  customPaletteSlot?: CustomPaletteSlot
  serverLocation?: ServerLocation
  shopGender?: ShopGender
  userSizes?: UserSizes
  /** Absent means on (the default). */
  sizesAgentContext?: boolean
}

/** PATCH body: `userSizes` is a merge patch — '' or null removes a category. */
export type SettingsPatch = Omit<Partial<AppSettings>, 'userSizes' | 'customPaletteSlot'> & {
  userSizes?: Partial<Record<string, string | null>>
  customPaletteSlot?: CustomPaletteSlot | null
}

export async function fetchSettings(): Promise<AppSettings> {
  return apiFetchJSON('/api/settings')
}

export async function saveSettings(patch: SettingsPatch): Promise<AppSettings> {
  return apiFetchJSON('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}
