import { describe, expect, it } from 'vitest'
import {
  meanAbsDiff, parseNvidiaSmiLine, percentile, reciprocalRank, recallAtK, spearman, summarize, topKOverlap,
  validateDecisionsFixture, validateRecallFixture,
} from '../../scripts/bench/metrics.js'

// #296 — the numbers the Phase 0 report is judged on.
describe('latency', () => {
  it('nearest-rank percentiles and a summary', () => {
    const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(percentile(v, 50)).toBe(500)
    expect(percentile(v, 95)).toBe(1000)
    expect(percentile([7], 95)).toBe(7)
    expect(summarize(v)).toEqual({ n: 10, p50: 500, p95: 1000, mean: 550, max: 1000 })
    expect(summarize([]).n).toBe(0)
  })
})

describe('decision agreement', () => {
  const jev = { a: 0.9, b: 0.7, c: 0.4, d: 0.1 }
  it('spearman is 1 for the same order, -1 for reversed, over shared ids only', () => {
    expect(spearman(jev, { a: 0.8, b: 0.6, c: 0.5, d: 0.2, extra: 1 })).toBeCloseTo(1)
    expect(spearman(jev, { a: 0.1, b: 0.4, c: 0.7, d: 0.9 })).toBeCloseTo(-1)
    expect(spearman(jev, { a: 1 })).toBeNaN()
  })

  it('handles ties with average ranks', () => {
    expect(spearman({ a: 1, b: 1, c: 0 }, { a: 1, b: 0.5, c: 0 })).toBeCloseTo(0.866, 2)
  })

  it('top-k overlap and mean absolute difference', () => {
    expect(topKOverlap(jev, { a: 0.9, c: 0.8, b: 0.1, d: 0.05 }, 2)).toBe(0.5)
    expect(meanAbsDiff({ a: 0.5, b: 0.5 }, { a: 0.7, b: 0.1, z: 1 })).toBeCloseTo(0.3)
  })
})

describe('retrieval', () => {
  it('recall@k is capped by the number of relevant docs; MRR is 1/first hit', () => {
    const ranked = ['x', 'a', 'y', 'b']
    expect(recallAtK(ranked, new Set(['a', 'b']), 2)).toBe(0.5)
    expect(recallAtK(ranked, new Set(['a', 'b']), 10)).toBe(1)
    expect(reciprocalRank(ranked, new Set(['b']))).toBe(0.25)
    expect(reciprocalRank(ranked, new Set(['q']))).toBe(0)
  })
})

describe('nvidia-smi parsing', () => {
  it('reads one csv line, ignores anything else', () => {
    expect(parseNvidiaSmiLine('0, 81234, 97871, 93')).toEqual({ index: 0, usedMb: 81234, totalMb: 97871, utilPct: 93 })
    expect(parseNvidiaSmiLine('No devices were found')).toBeNull()
  })
})

describe('fixture validation', () => {
  it('accepts well-formed fixtures and names what is wrong otherwise', () => {
    expect(validateDecisionsFixture({ version: 1, cases: [{ id: 'c', state: {}, questions: { q: { type: 'noul' } } }] }).cases).toHaveLength(1)
    expect(() => validateDecisionsFixture({ cases: [] })).toThrow(/version: 1/)
    expect(() => validateDecisionsFixture({ version: 1, cases: [{ id: 'c', questions: {} }] })).toThrow(/no questions/)
    expect(validateRecallFixture({ version: 1, docs: [{ id: 'a' }], queries: [{ id: 'q', kind: 'k', text: 't', relevant: ['a'] }] }).queries).toHaveLength(1)
    expect(() => validateRecallFixture({ version: 1, docs: [], queries: [{ id: 'q', kind: 'k', text: 't', relevant: ['a'] }] })).toThrow(/unknown doc a/)
  })
})
