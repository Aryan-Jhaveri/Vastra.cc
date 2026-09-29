// #377 — the iOS status bar follows the in-app theme via one theme-color meta
// tag that applyTheme() rewrites synchronously.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme,
  applyThemePreference,
  DEFAULT_STATUS_BAR_COLOR,
  installStatusBarColorSync,
  resetLocalTheme,
  type CustomThemePalette,
} from '../../src/lib/theme'

const palette: CustomThemePalette = {
  light: { primary: '#112233', secondary: '#fafafa', tertiary: '#333333' },
  dark: { primary: '#aabbcc', secondary: '#101010', tertiary: '#dddddd' },
}

const metas = () => document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
const statusColor = () => metas()[0]?.getAttribute('content')

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = '<meta name="theme-color" content="#ffffff" />'
  document.documentElement.removeAttribute('style')
  document.documentElement.className = ''
})

describe('theme-color meta tag', () => {
  it('index.html ships exactly one un-scoped theme-color tag with the default color', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const indexHtml = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
    const tags = indexHtml.match(/<meta name="theme-color"[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    expect(tags[0]).not.toContain('media=')
    expect(tags[0]).toContain(`content="${DEFAULT_STATUS_BAR_COLOR}"`)
  })

  it('switching built-in theme updates the color synchronously', () => {
    applyTheme('atelier', false, {}, null)
    expect(statusColor()).toBe('#fbf9f4')
    applyTheme('silk', false, {}, null)
    expect(statusColor()).toBe('#e8eaf0')
  })

  it('toggling dark mode updates the color', () => {
    applyThemePreference('terra', false, {}, null)
    expect(statusColor()).toBe('#f7faf4')
    applyThemePreference('terra', true, {}, null)
    expect(statusColor()).toBe('#0b0f0c')
  })

  it('a custom palette uses its secondary (page background) color per mode', () => {
    applyThemePreference('brutalist', false, { 3: palette }, 3)
    expect(statusColor()).toBe('#fafafa')
    applyThemePreference('brutalist', true, { 3: palette }, 3)
    expect(statusColor()).toBe('#101010')
  })

  it('the account reset (#375) sets it back to the default color', () => {
    applyThemePreference('silk', true, {}, null)
    expect(statusColor()).toBe('#0c1020')
    resetLocalTheme()
    expect(statusColor()).toBe(DEFAULT_STATUS_BAR_COLOR)
  })

  it('strips a leftover media attribute and never duplicates the tag', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#fafaf8" media="(prefers-color-scheme: light)" />'
    applyTheme('silk', true, {}, null)
    expect(metas()).toHaveLength(1)
    expect(metas()[0].hasAttribute('media')).toBe(false)
    expect(statusColor()).toBe('#0c1020')
  })

  it('creates the tag if it is missing', () => {
    document.head.innerHTML = ''
    applyTheme('atelier', true, {}, null)
    expect(statusColor()).toBe('#1b1c19')
  })

  it('re-applies the current color on visibilitychange and pageshow', () => {
    installStatusBarColorSync()
    installStatusBarColorSync() // idempotent
    applyTheme('silk', true, {}, null)
    metas()[0].setAttribute('content', '#123456') // simulate a stale value
    document.dispatchEvent(new Event('visibilitychange'))
    expect(statusColor()).toBe('#0c1020')
    metas()[0].setAttribute('content', '#123456')
    window.dispatchEvent(new Event('pageshow'))
    expect(statusColor()).toBe('#0c1020')
  })
})
