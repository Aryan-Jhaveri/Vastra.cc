import { VALID_THEME_IDS, type ThemeId } from '../constants/themes'

export interface Theme {
  id: ThemeId
  label: string
  description: string
  previewBg: string     // for the card preview swatch
  previewAccent: string
  light: Record<string, string>
  dark: Record<string, string>
}

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
  for (const [slot, palette] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[1-4]$/.test(slot) || typeof palette !== 'object' || palette === null || Array.isArray(palette)) return false
    const modes = palette as Record<string, unknown>
    if (Object.keys(modes).length !== 2 || !('light' in modes) || !('dark' in modes)) return false
    if (!isValidThemeModeColors(modes.light) || !isValidThemeModeColors(modes.dark)) return false
  }
  return true
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastingText(hex: string): string {
  return relativeLuminance(hex) > 0.179 ? '#000000' : '#ffffff'
}

function mixHex(foreground: string, background: string, foregroundWeight: number): string {
  const mixed = [1, 3, 5].map(offset => {
    const fg = parseInt(foreground.slice(offset, offset + 2), 16)
    const bg = parseInt(background.slice(offset, offset + 2), 16)
    return Math.round(fg * foregroundWeight + bg * (1 - foregroundWeight)).toString(16).padStart(2, '0')
  })
  return `#${mixed.join('')}`
}

function customPaletteVars(colors: ThemeModeColors, isDark: boolean): Record<string, string> {
  // A custom palette stands on its own: secondary is the page background,
  // while tertiary drives the border and outline family.
  const paper = colors.secondary
  const ink = contrastingText(paper)
  const surface = mixHex(paper, isDark ? '#ffffff' : '#000000', isDark ? 0.94 : 0.96)
  const surfaceDim = mixHex(paper, '#000000', 0.92)
  const surfaceBright = mixHex(paper, '#ffffff', isDark ? 0.88 : 0.98)
  const surfaceContainer = (weight: number) => mixHex(paper, isDark ? '#ffffff' : '#000000', weight)
  const primaryContainer = mixHex(colors.primary, paper, 0.18)
  const secondaryContainer = surface
  const tertiaryContainer = mixHex(colors.tertiary, paper, 0.18)
  const outlineVariant = mixHex(colors.tertiary, paper, 0.62)
  const muted = mixHex(ink, paper, 0.64)

  return {
    '--color-ink': ink,
    '--color-paper': paper,
    '--color-muted': muted,
    '--color-active': colors.primary,
    '--color-surface': surface,
    '--color-surface-dim': surfaceDim,
    '--color-surface-bright': surfaceBright,
    '--color-surface-container-lowest': surfaceContainer(isDark ? 0.98 : 0.97),
    '--color-surface-container-low': surfaceContainer(isDark ? 0.94 : 0.94),
    '--color-surface-container': surfaceContainer(isDark ? 0.90 : 0.91),
    '--color-surface-container-high': surfaceContainer(isDark ? 0.84 : 0.87),
    '--color-surface-container-highest': surfaceContainer(isDark ? 0.78 : 0.82),
    '--color-surface-variant': outlineVariant,
    '--color-surface-tint': colors.primary,
    '--color-on-surface': ink,
    '--color-on-surface-variant': contrastingText(outlineVariant),
    '--color-inverse-surface': ink,
    '--color-inverse-on-surface': paper,
    '--color-outline': colors.tertiary,
    '--color-outline-variant': outlineVariant,
    '--color-primary': colors.primary,
    '--color-on-primary': contrastingText(colors.primary),
    '--color-primary-container': primaryContainer,
    '--color-on-primary-container': contrastingText(primaryContainer),
    '--color-inverse-primary': colors.primary,
    '--color-secondary': colors.secondary,
    '--color-on-secondary': contrastingText(colors.secondary),
    '--color-secondary-container': secondaryContainer,
    '--color-on-secondary-container': contrastingText(secondaryContainer),
    '--color-tertiary': colors.tertiary,
    '--color-on-tertiary': contrastingText(colors.tertiary),
    '--color-tertiary-container': tertiaryContainer,
    '--color-on-tertiary-container': contrastingText(tertiaryContainer),
    '--color-error': isDark ? '#ff6b55' : '#cc2200',
    '--color-on-error': '#ffffff',
    '--color-error-container': isDark ? '#5c1007' : '#ffdad6',
    '--color-on-error-container': isDark ? '#ffdad6' : '#8b1200',
    '--color-success': isDark ? '#86d39a' : '#1a7a3c',
    '--color-background': paper,
    '--color-on-background': ink,
    '--color-accent': colors.primary,
    '--color-accent-on': contrastingText(colors.primary),
    '--color-hover': surfaceDim,
    '--color-selected': colors.primary,
    '--color-selected-on': contrastingText(colors.primary),
    '--color-shadow': isDark ? 'rgba(255, 255, 255, 0.5)' : ink,
  }
}

// All vars that drive the visual feel. Every theme sets all of them.
// Tailwind v4 auto-generates utilities from @theme vars — once we
// setProperty() these on <html>, every bg-ink/text-muted/etc updates.
const mkVars = (v: {
  ink: string; paper: string; muted: string; active: string
  surface: string; surfaceDim: string; surfaceBright: string
  scLowest: string; scLow: string; sc: string; scHigh: string; scHighest: string
  surfaceVariant: string
  onSurface: string; onSurfaceVariant: string
  inverseSurface: string; inverseOnSurface: string
  outline: string; outlineVariant: string
  primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string
  secondary: string; onSecondary: string; secondaryContainer: string; onSecondaryContainer: string
  tertiary: string; onTertiary: string; tertiaryContainer: string; onTertiaryContainer: string
  background: string; onBackground: string
  accent: string; accentOn: string
  error?: string; onError?: string
  success?: string
}) => ({
  '--color-ink':                          v.ink,
  '--color-paper':                        v.paper,
  '--color-muted':                        v.muted,
  '--color-active':                       v.active,
  '--color-surface':                      v.surface,
  '--color-surface-dim':                  v.surfaceDim,
  '--color-surface-bright':               v.surfaceBright,
  '--color-surface-container-lowest':     v.scLowest,
  '--color-surface-container-low':        v.scLow,
  '--color-surface-container':            v.sc,
  '--color-surface-container-high':       v.scHigh,
  '--color-surface-container-highest':    v.scHighest,
  '--color-surface-variant':              v.surfaceVariant,
  '--color-on-surface':                   v.onSurface,
  '--color-on-surface-variant':           v.onSurfaceVariant,
  '--color-inverse-surface':              v.inverseSurface,
  '--color-inverse-on-surface':           v.inverseOnSurface,
  '--color-outline':                      v.outline,
  '--color-outline-variant':              v.outlineVariant,
  '--color-primary':                      v.primary,
  '--color-on-primary':                   v.onPrimary,
  '--color-primary-container':            v.primaryContainer,
  '--color-on-primary-container':         v.onPrimaryContainer,
  '--color-secondary':                    v.secondary,
  '--color-on-secondary':                 v.onSecondary,
  '--color-secondary-container':          v.secondaryContainer,
  '--color-on-secondary-container':       v.onSecondaryContainer,
  '--color-tertiary':                     v.tertiary,
  '--color-on-tertiary':                  v.onTertiary,
  '--color-tertiary-container':           v.tertiaryContainer,
  '--color-on-tertiary-container':        v.onTertiaryContainer,
  '--color-background':                   v.background,
  '--color-on-background':                v.onBackground,
  '--color-accent':                       v.accent,
  '--color-accent-on':                    v.accentOn,
  '--color-error':                        v.error  ?? '#dc2626',
  '--color-on-error':                     v.onError ?? '#ffffff',
  '--color-success':                      v.success ?? '#16a34a',
})

export const THEMES: Theme[] = [
  // ─────────────────────────────────────────────────────────────
  // 0. BRUTALIST — monochrome black on white / white on black
  // ─────────────────────────────────────────────────────────────
  {
    id: 'brutalist',
    label: 'Brutalist',
    description: '',
    previewBg: '#ffffff',
    previewAccent: '#0a0a0a',
    light: mkVars({
      ink: '#0a0a0a',           paper: '#ffffff',
      muted: '#6b6b6b',         active: '#1a1a1a',
      surface: '#f5f5f5',       surfaceDim: '#ebebeb',     surfaceBright: '#ffffff',
      scLowest: '#ffffff',      scLow: '#f7f7f7',
      sc: '#f0f0f0',            scHigh: '#e8e8e8',          scHighest: '#e0e0e0',
      surfaceVariant: '#e0e0e0',
      onSurface: '#0a0a0a',     onSurfaceVariant: '#404040',
      inverseSurface: '#1a1a1a', inverseOnSurface: '#f0f0f0',
      outline: '#666666',       outlineVariant: '#bfbfbf',
      primary: '#0a0a0a',       onPrimary: '#ffffff',
      primaryContainer: '#e0e0e0', onPrimaryContainer: '#0a0a0a',
      secondary: '#4a4a4a',     onSecondary: '#ffffff',
      secondaryContainer: '#e8e8e8', onSecondaryContainer: '#2a2a2a',
      tertiary: '#525252',      onTertiary: '#ffffff',
      tertiaryContainer: '#e0e0e0', onTertiaryContainer: '#1a1a1a',
      background: '#f5f5f5',    onBackground: '#0a0a0a',
      accent: '#0a0a0a',        accentOn: '#ffffff',
      error: '#cc2200',
    }),
    dark: mkVars({
      ink: '#f5f5f5',           paper: '#0a0a0a',
      muted: '#8a8a8a',         active: '#e8e8e8',
      surface: '#141414',       surfaceDim: '#0a0a0a',     surfaceBright: '#1e1e1e',
      scLowest: '#080808',      scLow: '#101010',
      sc: '#181818',            scHigh: '#222222',          scHighest: '#303030',
      surfaceVariant: '#222222',
      onSurface: '#f5f5f5',     onSurfaceVariant: '#aaaaaa',
      inverseSurface: '#f0f0f0', inverseOnSurface: '#1a1a1a',
      outline: '#444444',       outlineVariant: '#2a2a2a',
      primary: '#f5f5f5',       onPrimary: '#0a0a0a',
      primaryContainer: '#1a1a1a', onPrimaryContainer: '#e0e0e0',
      secondary: '#aaaaaa',     onSecondary: '#0a0a0a',
      secondaryContainer: '#222222', onSecondaryContainer: '#e8e8e8',
      tertiary: '#d6d6d6',      onTertiary: '#1a1a1a',
      tertiaryContainer: '#343434', onTertiaryContainer: '#ededed',
      background: '#0a0a0a',    onBackground: '#f5f5f5',
      accent: '#f5f5f5',        accentOn: '#0a0a0a',
      error: '#ff6b55',         onError: '#1a0000',
    }),
  },

  // ─────────────────────────────────────────────────────────────
  // 2. ATELIER — deep walnut on warm parchment
  // ─────────────────────────────────────────────────────────────
  {
    id: 'atelier',
    label: 'Atelier',
    description: '',
    previewBg: '#fbf9f4',
    previewAccent: '#26170c',
    light: mkVars({
      ink: '#1b1c19',         paper: '#fbf9f4',
      muted: '#81756e',       active: '#4f453f',
      surface: '#fbf9f4',     surfaceDim: '#dbdad5',   surfaceBright: '#fbf9f4',
      scLowest: '#ffffff',    scLow: '#f5f3ee',
      sc: '#f0eee9',          scHigh: '#eae8e3',        scHighest: '#e4e2dd',
      surfaceVariant: '#e4e2dd',
      onSurface: '#1b1c19',   onSurfaceVariant: '#4f453f',
      inverseSurface: '#30312e', inverseOnSurface: '#f2f1ec',
      outline: '#81756e',     outlineVariant: '#d2c4bc',
      primary: '#26170c',     onPrimary: '#ffffff',
      primaryContainer: '#3d2b1f', onPrimaryContainer: '#ac9181',
      secondary: '#7c5730',   onSecondary: '#ffffff',
      secondaryContainer: '#fdcb9b', onSecondaryContainer: '#79542d',
      tertiary: '#76594a',   onTertiary: '#ffffff',
      tertiaryContainer: '#efded2', onTertiaryContainer: '#39261b',
      background: '#fbf9f4',  onBackground: '#1b1c19',
      accent: '#7c5730',      accentOn: '#ffffff',
      error: '#ba1a1a',
    }),
    dark: mkVars({
      ink: '#f2f1ec',         paper: '#1b1c19',
      muted: '#9e9088',       active: '#eebd8e',
      surface: '#1b1c19',     surfaceDim: '#151610',   surfaceBright: '#30312e',
      scLowest: '#151610',    scLow: '#1e1f1b',
      sc: '#242320',          scHigh: '#2e302a',        scHighest: '#383a34',
      surfaceVariant: '#383a34',
      onSurface: '#f2f1ec',   onSurfaceVariant: '#d2c4bc',
      inverseSurface: '#f2f1ec', inverseOnSurface: '#30312e',
      outline: '#80756e',     outlineVariant: '#4f453f',
      primary: '#eebd8e',     onPrimary: '#381e0a',
      primaryContainer: '#3d2b1f', onPrimaryContainer: '#fbddca',
      secondary: '#ffdcbd',   onSecondary: '#412406',
      secondaryContainer: '#7c5730', onSecondaryContainer: '#fdcb9b',
      tertiary: '#e0bda9',   onTertiary: '#3d2920',
      tertiaryContainer: '#523c31', onTertiaryContainer: '#f7dbcb',
      background: '#1b1c19',  onBackground: '#f2f1ec',
      accent: '#eebd8e',      accentOn: '#381e0a',
      error: '#ffb4ab',       onError: '#690005',
    }),
  },

  // ─────────────────────────────────────────────────────────────
  // 3. SILK — violet-purple on cool gray
  // ─────────────────────────────────────────────────────────────
  {
    id: 'silk',
    label: 'Silk',
    description: '',
    previewBg: '#e8eaf0',
    previewAccent: '#8b5cf6',
    light: mkVars({
      ink: '#1a1c2e',         paper: '#e8eaf0',
      muted: '#8e8fa8',       active: '#8b5cf6',
      surface: '#e8eaf0',     surfaceDim: '#d6d8e0',   surfaceBright: '#e8eaf0',
      scLowest: '#ffffff',    scLow: '#eef0f6',
      sc: '#e6e8f0',          scHigh: '#dee0ea',        scHighest: '#d4d6e2',
      surfaceVariant: '#d4d6e2',
      onSurface: '#1a1c2e',   onSurfaceVariant: '#4a4c66',
      inverseSurface: '#2e3042', inverseOnSurface: '#f0f0f6',
      outline: '#6a6c88',     outlineVariant: '#c4c6d8',
      primary: '#8b5cf6',     onPrimary: '#ffffff',
      primaryContainer: '#ede9fe', onPrimaryContainer: '#3b0764',
      secondary: '#7c3aed',   onSecondary: '#ffffff',
      secondaryContainer: '#f0e0ff', onSecondaryContainer: '#30006e',
      tertiary: '#45636d',   onTertiary: '#ffffff',
      tertiaryContainer: '#cce8ef', onTertiaryContainer: '#102f38',
      background: '#e8eaf0',  onBackground: '#1a1c2e',
      accent: '#8b5cf6',      accentOn: '#ffffff',
    }),
    dark: mkVars({
      ink: '#dce3ff',         paper: '#0c1020',
      muted: '#7080b8',       active: '#c4b5fd',
      surface: '#141c30',     surfaceDim: '#0c1020',   surfaceBright: '#1c2840',
      scLowest: '#080e1a',    scLow: '#121a2e',
      sc: '#1a2440',          scHigh: '#222e50',        scHighest: '#2c3860',
      surfaceVariant: '#2c3860',
      onSurface: '#dce3ff',   onSurfaceVariant: '#a8b8e0',
      inverseSurface: '#dce3ff', inverseOnSurface: '#1c2840',
      outline: '#4458a0',     outlineVariant: '#2a3560',
      primary: '#a78bfa',     onPrimary: '#1a0033',
      primaryContainer: '#4c1d95', onPrimaryContainer: '#ede9fe',
      secondary: '#a08cff',   onSecondary: '#0a0040',
      secondaryContainer: '#2a0080', onSecondaryContainer: '#e4d8ff',
      tertiary: '#b0ced6',   onTertiary: '#18363d',
      tertiaryContainer: '#304c54', onTertiaryContainer: '#cce8ef',
      background: '#0c1020',  onBackground: '#dce3ff',
      accent: '#a78bfa',      accentOn: '#1a0033',
    }),
  },

  // ─────────────────────────────────────────────────────────────
  // 4. ROYAL — burnished gold on midnight vault
  // ─────────────────────────────────────────────────────────────
  {
    id: 'terra',
    label: 'Terra',
    description: '',
    previewBg: '#f7faf4',
    previewAccent: '#386948',
    light: mkVars({
      ink: '#2c342e',         paper: '#f7faf4',
      muted: '#59615a',       active: '#386948',
      surface: '#f7faf4',     surfaceDim: '#d3dcd3',   surfaceBright: '#f7faf4',
      scLowest: '#ffffff',    scLow: '#f0f5ee',
      sc: '#e9f0e8',          scHigh: '#e3eae2',        scHighest: '#dce5db',
      surfaceVariant: '#dce5db',
      onSurface: '#2c342e',   onSurfaceVariant: '#59615a',
      inverseSurface: '#0b0f0c', inverseOnSurface: '#9a9e99',
      outline: '#747d75',     outlineVariant: '#abb4ac',
      primary: '#386948',     onPrimary: '#ffffff',
      primaryContainer: '#b9efc5', onPrimaryContainer: '#2a5b3b',
      secondary: '#665e53',   onSecondary: '#ffffff',
      secondaryContainer: '#ece1d3', onSecondaryContainer: '#585146',
      tertiary: '#735c2e',   onTertiary: '#ffffff',
      tertiaryContainer: '#f5e2aa', onTertiaryContainer: '#251a00',
      background: '#f7faf4',  onBackground: '#2c342e',
      accent: '#386948',      accentOn: '#ffffff',
      error: '#a83836',       onError: '#ffffff',
      success: '#386948',
    }),
    dark: mkVars({
      ink: '#dce5db',         paper: '#0b0f0c',
      muted: '#9a9e99',       active: '#b9efc5',
      surface: '#0b0f0c',     surfaceDim: '#060806',   surfaceBright: '#141814',
      scLowest: '#060806',    scLow: '#0e120e',
      sc: '#141814',          scHigh: '#1a201a',        scHighest: '#222822',
      surfaceVariant: '#222822',
      onSurface: '#dce5db',   onSurfaceVariant: '#abb4ac',
      inverseSurface: '#dce5db', inverseOnSurface: '#0b0f0c',
      outline: '#5a645a',     outlineVariant: '#2e342e',
      primary: '#b9efc5',     onPrimary: '#15482a',
      primaryContainer: '#2a5b3b', onPrimaryContainer: '#abe1b7',
      secondary: '#ece1d3',   onSecondary: '#453e34',
      secondaryContainer: '#585146', onSecondaryContainer: '#ded3c5',
      tertiary: '#dfc386',   onTertiary: '#3e2e08',
      tertiaryContainer: '#594619', onTertiaryContainer: '#f5e2aa',
      background: '#0b0f0c',  onBackground: '#dce5db',
      accent: '#b9efc5',      accentOn: '#15482a',
      error: '#fa746f',       onError: '#6e0a12',
    }),
  },
]

export function applyTheme(
  themeId: string,
  isDark: boolean,
  customPalettes: CustomThemePalettes = loadSavedCustomPalettes(),
  customPaletteSlot: CustomPaletteSlot | null = loadSavedCustomPaletteSlot(),
) {
  const theme = THEMES.find(t => t.id === themeId) ?? THEMES[0]
  const customPalette = customPaletteSlot === null ? undefined : customPalettes[customPaletteSlot]
  const validPalettes = isValidCustomThemePalettes(customPalettes)
  const vars = customPalette && validPalettes
    ? customPaletteVars(isDark ? customPalette.dark : customPalette.light, isDark)
    : { ...(isDark ? theme.dark : theme.light) }
  const html = document.documentElement
  html.classList.toggle('custom-palette', Boolean(customPalette && validPalettes))
  for (const [key, value] of Object.entries(vars)) {
    html.style.setProperty(key, value)
  }
  setStatusBarColor(vars['--color-paper'])
}

// ── iOS status bar / theme-color meta (#377) ───────────────────
// Safari only re-evaluates media-scoped theme-color tags on load or a
// visibility change, and never knows about the in-app theme. index.html ships
// one un-scoped tag; applyTheme() writes the resolved paper color into it.
export const DEFAULT_STATUS_BAR_COLOR = '#ffffff'

function themeColorMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  return meta
}

let lastStatusBarColor = DEFAULT_STATUS_BAR_COLOR

export function setStatusBarColor(color: string | undefined): void {
  const next = color && HEX_COLOR_PATTERN.test(color) ? color : DEFAULT_STATUS_BAR_COLOR
  lastStatusBarColor = next
  const meta = themeColorMeta()
  // Drop any media scoping left over from an older cached index.html so the
  // tag always applies regardless of the OS color scheme.
  meta.removeAttribute('media')
  meta.setAttribute('content', next)
}

/** Re-write the current color. Defensive fallback for WebKit missing a change. */
export function reapplyStatusBarColor(): void {
  setStatusBarColor(lastStatusBarColor)
}

let statusBarListenersInstalled = false

/** Register once at boot (main.tsx): re-apply on foreground / bfcache restore. */
export function installStatusBarColorSync(): void {
  if (statusBarListenersInstalled) return
  statusBarListenersInstalled = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reapplyStatusBarColor()
  })
  window.addEventListener('pageshow', reapplyStatusBarColor)
}

export function loadSavedTheme(): string {
  try { return localStorage.getItem('closet:theme') ?? 'brutalist' } catch { return 'brutalist' }
}

export function saveTheme(id: string) {
  try { localStorage.setItem('closet:theme', id) } catch { /* ignore */ }
}

export function loadSavedCustomPalettes(): CustomThemePalettes {
  try {
    const stored = localStorage.getItem('closet:customPalettes')
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    return isValidCustomThemePalettes(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function saveCustomPalettes(palettes: CustomThemePalettes): void {
  try {
    if (isValidCustomThemePalettes(palettes)) {
      if (Object.keys(palettes).length === 0) localStorage.removeItem('closet:customPalettes')
      else localStorage.setItem('closet:customPalettes', JSON.stringify(palettes))
    }
  } catch { /* ignore */ }
}

export function loadSavedCustomPaletteSlot(): CustomPaletteSlot | null {
  try {
    const stored = localStorage.getItem('closet:customPaletteSlot')
    if (!stored || !/^[1-4]$/.test(stored)) return null
    const slot = Number(stored) as CustomPaletteSlot
    return loadSavedCustomPalettes()[slot] ? slot : null
  } catch {
    return null
  }
}

export function saveCustomPaletteSlot(slot: CustomPaletteSlot | null): void {
  try {
    if (slot === null) localStorage.removeItem('closet:customPaletteSlot')
    else localStorage.setItem('closet:customPaletteSlot', String(slot))
  } catch { /* ignore */ }
}

export type ColorScheme = 'dark' | 'light'

/** Apply theme + dark/light to DOM and localStorage (instant UI). */
export function applyThemePreference(
  themeId: string,
  isDark: boolean,
  customPalettes: CustomThemePalettes = loadSavedCustomPalettes(),
  customPaletteSlot: CustomPaletteSlot | null = loadSavedCustomPaletteSlot(),
): void {
  try { localStorage.setItem('theme', isDark ? 'dark' : 'light') } catch { /* ignore */ }
  saveTheme(themeId)
  saveCustomPalettes(customPalettes)
  saveCustomPaletteSlot(customPaletteSlot)
  if (isDark) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
  applyTheme(themeId, isDark, customPalettes, customPaletteSlot)
}

/** Fallback when logged out or account has no saved theme prefs. */
export function applyLocalThemePreference(): void {
  applyThemePreference(loadSavedTheme(), localStorage.getItem('theme') === 'dark')
}

/** Account prefs from GET /api/settings — overrides local when present. */
export function applyAccountThemePreference(
  themeId?: string,
  colorScheme?: ColorScheme,
  customPalettes?: CustomThemePalettes,
  customPaletteSlot?: CustomPaletteSlot,
): void {
  // The account is the source of truth: a field it hasn't saved means the
  // default, never whatever the last account on this browser left in
  // localStorage (#375).
  const id = themeId && THEMES.some(t => t.id === themeId) ? themeId : DEFAULT_THEME_ID
  const isDark = colorScheme === 'dark'
  applyThemePreference(id, isDark, customPalettes ?? {}, customPaletteSlot ?? null)
}

// ── account-local theme reset (#375) ───────────────────────────
export const DEFAULT_THEME_ID = 'brutalist'

/** localStorage keys that hold the signed-in account's theme choice. */
export const THEME_STORAGE_KEYS = [
  'closet:theme',
  'closet:customPalettes',
  'closet:customPaletteSlot',
  'theme',
] as const

/**
 * Drop the stored theme and paint the default (Brutalist, light, no custom
 * palette). Runs on sign-out and on a rejected session so the next account on
 * this browser doesn't inherit the previous one's theme.
 */
export function resetLocalTheme(): void {
  for (const key of THEME_STORAGE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
  }
  document.documentElement.classList.remove('dark')
  applyTheme(DEFAULT_THEME_ID, false, {}, null)
}

// ── backward-compat shims ──────────────────────────────────────
export const ACCENT_PRESETS = THEMES.map(t => ({
  id: t.id, label: t.label, color: t.previewAccent, on: '#ffffff',
}))
export const applyAccent = (id: string) => applyTheme(id, localStorage.getItem('theme') === 'dark')
export const loadSavedAccent = loadSavedTheme
export const saveAccent = saveTheme
export type AccentPreset = (typeof ACCENT_PRESETS)[number]
