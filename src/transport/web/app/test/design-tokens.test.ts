import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(
  resolve(__dirname, '../src/index.css'),
  'utf8',
)

function getVar(name: string): string | undefined {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return match?.[1].trim()
}

function hasClass(selector: string): boolean {
  return new RegExp(`\\.${selector}\\s*\\{`).test(css)
}

describe('design tokens — colors', () => {
  it.each([
    ['color-ink', '#0a0a0a'],
    ['color-paper', '#ffffff'],
    ['color-muted', '#444444'],
    ['color-active', '#1a1a1a'],
    ['color-surface', '#f5f5f5'],
    ['color-surface-dim', '#ebebeb'],
    ['color-on-surface', '#0a0a0a'],
    ['color-outline', '#666666'],
    ['color-primary', '#0a0a0a'],
    ['color-on-primary', '#ffffff'],
    ['color-error', '#cc2200'],
    ['color-success', '#1a7a3c'],
    ['color-background', '#f5f5f5'],
  ])('--%s = %s', (name, value) => {
    expect(getVar(name)).toBe(value)
  })
})

describe('design tokens — fonts', () => {
  it('--font-sans is Space Grotesk', () => {
    expect(getVar('font-sans')).toContain('Space Grotesk')
  })

  it('--font-mono uses readable sans-serif', () => {
    expect(getVar('font-mono')).toContain('Space Grotesk')
  })
})

describe('design tokens — typography classes', () => {
  it.each([
    'text-headline-lg',
    'text-headline-md',
    'text-body-md',
    'text-label-bold',
    'text-label-sm',
    'text-metadata-xs',
    'text-button',
  ])('.%s is defined', (selector) => {
    expect(hasClass(selector)).toBe(true)
  })
})

describe('design tokens — spacing', () => {
  it('--spacing-layout-safe-bottom = 96px', () => {
    expect(getVar('spacing-layout-safe-bottom')).toBe('96px')
  })
})
