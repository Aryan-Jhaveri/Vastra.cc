import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyAccountThemePreference,
  applyTheme,
  loadSavedCustomPaletteSlot,
  loadSavedCustomPalettes,
  saveCustomPaletteSlot,
  saveCustomPalettes,
  type CustomThemePalette,
} from '../../src/lib/theme'

const palette: CustomThemePalette = {
  light: { primary: '#112233', secondary: '#fafafa', tertiary: '#333333' },
  dark: { primary: '#aabbcc', secondary: '#101010', tertiary: '#dddddd' },
}
const css = (name: string) => document.documentElement.style.getPropertyValue(name)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  document.documentElement.className = ''
})

describe('custom palette storage', () => {
  it('round-trips palettes and the selected slot', () => {
    saveCustomPalettes({ 2: palette })
    saveCustomPaletteSlot(2)
    expect(loadSavedCustomPalettes()).toEqual({ 2: palette })
    expect(loadSavedCustomPaletteSlot()).toBe(2)
  })

  it('ignores tampered or corrupt localStorage', () => {
    localStorage.setItem('closet:customPalettes', JSON.stringify({ 1: { light: { primary: 'red' }, dark: palette.dark } }))
    expect(loadSavedCustomPalettes()).toEqual({})
    localStorage.setItem('closet:customPalettes', '{oops')
    expect(loadSavedCustomPalettes()).toEqual({})
  })

  it('does not restore a selected slot whose palette is gone', () => {
    saveCustomPalettes({ 1: palette })
    saveCustomPaletteSlot(3)
    expect(loadSavedCustomPaletteSlot()).toBeNull()
  })

  it('removes the key when every slot is cleared', () => {
    saveCustomPalettes({ 1: palette })
    saveCustomPalettes({})
    expect(localStorage.getItem('closet:customPalettes')).toBeNull()
  })
})

describe('applyTheme with a custom palette', () => {
  it('maps primary → accent, secondary → paper, tertiary → outline, per mode', () => {
    applyTheme('brutalist', false, { 1: palette }, 1)
    expect(css('--color-primary')).toBe('#112233')
    expect(css('--color-paper')).toBe('#fafafa')
    expect(css('--color-outline')).toBe('#333333')
    expect(css('--color-ink')).toBe('#000000')
    expect(document.documentElement.classList.contains('custom-palette')).toBe(true)

    applyTheme('brutalist', true, { 1: palette }, 1)
    expect(css('--color-paper')).toBe('#101010')
    expect(css('--color-ink')).toBe('#ffffff')
  })

  it('falls back to the preset theme when no slot is selected', () => {
    applyTheme('brutalist', false, { 1: palette }, 1)
    applyTheme('brutalist', false, { 1: palette }, null)
    expect(css('--color-paper')).not.toBe('#fafafa')
    expect(document.documentElement.classList.contains('custom-palette')).toBe(false)
  })

  it('account prefs apply the saved slot and persist it locally', () => {
    applyAccountThemePreference('brutalist', 'light', { 4: palette }, 4)
    expect(css('--color-primary')).toBe('#112233')
    expect(loadSavedCustomPaletteSlot()).toBe(4)
  })
})
