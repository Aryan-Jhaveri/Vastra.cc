import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/tools/outfits.js', () => ({
  getOutfitWithItems: vi.fn(),
}))

import { outfitReminderJob } from '../../src/jobs/types/outfitReminder.js'
import * as outfitTools from '../../src/tools/outfits.js'
import type { JobContext } from '../../src/jobs/registry.js'

const ctx: JobContext = { jobId: 'test-job', userId: 'self' }

const baseOutfit = {
  id: 'outfit-1',
  name: 'Summer Vibes',
  occasion: 'casual',
  notes: 'Light and breezy',
  itemIds: '["item-1","item-2"]',
  items: [
    { id: 'item-1', imageUri: 'images/items/a.jpg', category: 'top', subcategory: 't-shirt', primaryColor: 'white' },
    { id: 'item-2', imageUri: 'images/items/b.jpg', category: 'bottom', subcategory: 'shorts', primaryColor: 'blue' },
  ],
}

describe('outfitReminderJob.execute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns a durable outfit snapshot in resultJson when outfit is found', async () => {
    vi.mocked(outfitTools.getOutfitWithItems).mockResolvedValue(
      baseOutfit as ReturnType<typeof outfitTools.getOutfitWithItems> extends Promise<infer T> ? T : never,
    )

    const result = await outfitReminderJob.execute({ outfitId: 'outfit-1' }, ctx)
    const suggestion = result && 'suggestions' in result ? result.suggestions?.[0] : undefined

    expect(suggestion).toBeDefined()
    expect(suggestion?.name).toBe('Summer Vibes')
    expect(suggestion?.occasion).toBe('casual')
    expect(suggestion?.reasoning).toBe('Light and breezy')
    expect(suggestion?.item_ids).toEqual(['item-1', 'item-2'])
    // items ride along so OutfitCard renders the outfit even after the source
    // outfit is deleted
    expect((suggestion as { items?: unknown[] }).items).toHaveLength(2)
  })

  it('forwards ctx.userId to getOutfitWithItems for per-user scoping', async () => {
    vi.mocked(outfitTools.getOutfitWithItems).mockResolvedValue(
      baseOutfit as ReturnType<typeof outfitTools.getOutfitWithItems> extends Promise<infer T> ? T : never,
    )

    await outfitReminderJob.execute({ outfitId: 'outfit-1' }, { jobId: 'j', userId: 'user-b' })
    expect(outfitTools.getOutfitWithItems).toHaveBeenCalledWith('outfit-1', 'user-b')
  })

  it('logs warning and returns undefined when outfit not found', async () => {
    vi.mocked(outfitTools.getOutfitWithItems).mockResolvedValue(null)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await outfitReminderJob.execute({ outfitId: 'gone' }, ctx)
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('gone'))

    warnSpy.mockRestore()
  })
})

describe('outfitReminderJob.paramsSchema', () => {
  it('accepts valid params', () => {
    expect(outfitReminderJob.paramsSchema.safeParse({ outfitId: 'abc' }).success).toBe(true)
  })

  it('rejects missing outfitId', () => {
    expect(outfitReminderJob.paramsSchema.safeParse({}).success).toBe(false)
  })
})
