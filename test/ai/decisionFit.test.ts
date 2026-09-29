import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHARS_PER_TOKEN, decisionsMaxTokens, fitDecisionsRequest, fitEntry, fitText } from '../../src/ai/decisionFit.js'

// #351 — CLM-8B cuts anything past its 2048-token window from the end, which
// would silently drop an outfit's last items. Shrink the least useful fields
// everywhere first; cut only as a last resort.
const item = (n: number) => ({
  category: 'tops', subcategory: `shirt ${n}`, primaryColor: 'navy', colors: ['navy', 'white'],
  material: 'cotton', brand: 'Uniqlo', season: ['spring'], tags: ['work', 'smart'],
  description: 'A crisp oxford shirt with a button-down collar. '.repeat(4),
})
const outfit = (items: number) => ({ name: 'Office', occasion: 'work', items: Array.from({ length: items }, (_, i) => item(i)) })
const question = (items: number) => `Is this outfit a good pick for the given context? Outfit JSON: ${JSON.stringify(outfit(items))}`

afterEach(() => vi.unstubAllEnvs())

describe('fitText', () => {
  it('leaves text within budget untouched', () => {
    const q = question(2)
    expect(fitText(q, q.length)).toBe(q)
  })

  it('drops descriptions (then tags…) from every item before losing any item', () => {
    const q = question(8)
    const budget = Math.floor(q.length * 0.6)
    const fitted = fitText(q, budget)
    expect(fitted.length).toBeLessThanOrEqual(budget)
    expect(fitted.startsWith('Is this outfit a good pick for the given context? Outfit JSON: ')).toBe(true)
    const parsed = JSON.parse(fitted.slice(fitted.indexOf('{')))
    expect(parsed.items).toHaveLength(8)
    expect(parsed.items.every((i: Record<string, unknown>) => !('description' in i))).toBe(true)
    expect(parsed.items[7]).toMatchObject({ subcategory: 'shirt 7', primaryColor: 'navy' })
  })

  it('only drops as many fields as it needs to', () => {
    const q = question(3)
    const withoutDescriptions = `${q.slice(0, q.indexOf('{'))}${JSON.stringify({ ...outfit(3), items: outfit(3).items.map(({ description: _d, ...rest }) => rest) })}`
    expect(fitText(q, withoutDescriptions.length)).toBe(withoutDescriptions) // tags survive
  })

  it('cuts with an ellipsis when shrinking is not enough, or the text has no JSON', () => {
    expect(fitText(question(40), 300)).toHaveLength(300)
    expect(fitText(question(40), 300).endsWith('…')).toBe(true)
    expect(fitText('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('fitEntry', () => {
  it('keeps an object an object when shrinking suffices', () => {
    const entry = outfit(4)
    const fitted = fitEntry(entry, JSON.stringify(entry).length - 50) as Record<string, unknown>
    expect(typeof fitted).toBe('object')
    expect((fitted.items as unknown[]).length).toBe(4)
  })

  it('passes null / undefined through', () => {
    expect(fitEntry(null, 1)).toBeNull()
    expect(fitEntry(undefined, 1)).toBeUndefined()
  })
})

describe('fitDecisionsRequest', () => {
  it('fits each question to the token budget, counts what shrank, and reuses untouched questions', () => {
    const small = { type: 'noul' as const, instructions: question(1) }
    const big = { type: 'noul' as const, instructions: question(30) }
    const { state, questions, trimmed } = fitDecisionsRequest({ weather: 'snow' }, { small, big }, 2048)
    expect(state).toEqual({ weather: 'snow' })
    expect(questions.small).toBe(small)
    expect(String(questions.big.instructions).length).toBeLessThanOrEqual(2048 * CHARS_PER_TOKEN)
    expect(trimmed).toBe(1)
  })

  it('reads DECISIONS_MAX_TOKENS, defaulting to 2048', () => {
    expect(decisionsMaxTokens()).toBe(2048)
    vi.stubEnv('DECISIONS_MAX_TOKENS', '4096')
    expect(decisionsMaxTokens()).toBe(4096)
    vi.stubEnv('DECISIONS_MAX_TOKENS', 'lots')
    expect(decisionsMaxTokens()).toBe(2048)
  })
})
