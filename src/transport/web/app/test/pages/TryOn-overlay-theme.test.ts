import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const tryonSrc = readFileSync(
  resolve(__dirname, '../../src/pages/TryOn.tsx'),
  'utf8',
)

describe('TryOn overlay theming (#287)', () => {
  it('uses the shared themed OverlayRemoveButton at all three overlay call sites', () => {
    expect(tryonSrc.match(/<OverlayRemoveButton/g)?.length).toBe(3)
  })

  it('contains no hardcoded overlay colors', () => {
    expect(tryonSrc).not.toContain('bg-black/50')
    expect(tryonSrc).not.toContain('border-white')
    expect(tryonSrc).not.toContain('text-white')
  })
})
