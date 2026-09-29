import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../../src/ai/categorize.js'

describe('buildPrompt', () => {
  it('includes STRICT RULES in the output', () => {
    const prompt = buildPrompt([], [])
    expect(prompt).toContain('STRICT RULES')
    expect(prompt).toContain('Describe ONLY the garment/accessory')
    expect(prompt).toContain('Never reference a person')
    expect(prompt).toContain('Use neutral, factual language')
    expect(prompt).toContain('single sentence')
    expect(prompt).toContain('≤ 20 words')
  })

  it('appends existing subcategories when provided', () => {
    const prompt = buildPrompt([], ['t-shirt', 'jeans'])
    expect(prompt).toContain('Existing subcategories in this wardrobe')
    expect(prompt).toContain('t-shirt, jeans')
  })

  it('appends existing tags when provided', () => {
    const prompt = buildPrompt(['casual', 'streetwear'], ['t-shirt'])
    expect(prompt).toContain('Existing tags in this wardrobe')
    expect(prompt).toContain('casual, streetwear')
  })
})
