import { describe, expect, it } from 'vitest'
import { fuseOutfitSignals, itemSeededOutfitIds } from '../../src/ai/discoverRetrieval.js'

const o = (id: string, itemIds: string[], createdAt = 0) => ({ id, itemIds: JSON.stringify(itemIds), createdAt })

describe('itemSeededOutfitIds', () => {
  it('ranks by mean reciprocal seed rank and skips excluded / unseeded outfits', () => {
    const saved = [o('big', ['a', 'x', 'y', 'z']), o('tight', ['a', 'b']), o('none', ['q']), o('ex', ['a'])]
    expect(itemSeededOutfitIds(saved, ['a', 'b'], new Set(['ex']))).toEqual(['tight', 'big'])
  })
})

describe('fuseOutfitSignals', () => {
  it('pads fused results with recent outfits, but never returns recency alone', () => {
    const saved = [o('s1', [], 1), o('old', [], 2), o('new', [], 3)]
    expect(fuseOutfitSignals(['s1'], [], saved, new Set(), 3)).toEqual(['s1', 'new', 'old'])
    expect(fuseOutfitSignals([], [], saved, new Set(), 3)).toEqual([])
  })
})
