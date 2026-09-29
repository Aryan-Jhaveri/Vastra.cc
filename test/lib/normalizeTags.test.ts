import { describe, it, expect } from 'vitest'
import { normalizeTags } from '../../src/lib/normalizeTags.js'

describe('normalizeTags', () => {
  it('trims whitespace', () => {
    expect(normalizeTags(['  formal  ', 'casual'])).toEqual(['formal', 'casual'])
  })

  it('lowercases', () => {
    expect(normalizeTags(['Formal', 'FORMAL', 'Casual'])).toEqual(['formal', 'casual'])
  })

  it('deduplicates after normalization', () => {
    expect(normalizeTags(['Formal', 'FORMAL', '  formal  ', 'Casual'])).toEqual(['formal', 'casual'])
  })

  it('filters non-string values', () => {
    expect(normalizeTags(['formal', 123, null, undefined, 'casual'])).toEqual(['formal', 'casual'])
  })

  it('returns empty array for non-array input', () => {
    expect(normalizeTags('not an array')).toEqual([])
    expect(normalizeTags(null)).toEqual([])
    expect(normalizeTags(undefined)).toEqual([])
    expect(normalizeTags(42)).toEqual([])
    expect(normalizeTags({})).toEqual([])
  })

  it('filters empty strings', () => {
    expect(normalizeTags(['formal', '', '  ', 'casual'])).toEqual(['formal', 'casual'])
  })

  it('preserves empty array', () => {
    expect(normalizeTags([])).toEqual([])
  })

  it('preserves order of first occurrence', () => {
    expect(normalizeTags(['b', 'a', 'B', 'A'])).toEqual(['b', 'a'])
  })
})
