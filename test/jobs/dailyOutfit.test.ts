import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/tools/items.js', () => ({ listItems: vi.fn() }))
vi.mock('../../src/tools/weather.js', () => ({ getCurrentWeather: vi.fn() }))
vi.mock('../../src/ai/suggest.js', () => ({ suggestOutfits: vi.fn() }))

import { dailyOutfitJob } from '../../src/jobs/types/dailyOutfit.js'
import * as items from '../../src/tools/items.js'
import * as weather from '../../src/tools/weather.js'
import * as suggest from '../../src/ai/suggest.js'

const closet = [
  { id: 'item-1', imageUri: 'images/items/a.jpg', category: 'top' },
  { id: 'item-2', imageUri: 'images/items/b.jpg', category: 'bottom' },
  { id: 'item-3', imageUri: 'images/items/c.jpg', category: 'shoes' },
]

const params = { lat: 43.7, lon: -79.4, locationName: 'Toronto' }

type ItemsList = Awaited<ReturnType<typeof items.listItems>>
type Suggestions = Awaited<ReturnType<typeof suggest.suggestOutfits>>
type Weather = Awaited<ReturnType<typeof weather.getCurrentWeather>>

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(weather.getCurrentWeather).mockResolvedValue({ temperature: 10 } as Weather)
  vi.mocked(items.listItems).mockResolvedValue(closet as ItemsList)
  vi.mocked(suggest.suggestOutfits).mockResolvedValue([
    { item_ids: ['item-1', 'item-2'], name: 'Layered Look', occasion: 'casual', reasoning: 'cozy' },
  ] as Suggestions)
})

describe('dailyOutfitJob.execute', () => {
  it('threads ctx.userId into listItems and suggestOutfits (no hardcoded self)', async () => {
    await dailyOutfitJob.execute(params, { jobId: 'j', userId: 'user-b' })

    expect(items.listItems).toHaveBeenCalledWith({}, 'user-b')
    expect(suggest.suggestOutfits).toHaveBeenCalledWith(
      expect.anything(), closet, 'user-b', undefined, undefined, expect.any(Number), expect.any(Number), 'j',
    )
  })

  it('hydrates items into each suggestion from the firing user\'s closet', async () => {
    const result = await dailyOutfitJob.execute(params, { jobId: 'j', userId: 'self' })
    const suggestion = result && 'suggestions' in result ? result.suggestions?.[0] : undefined

    expect(suggestion).toBeDefined()
    expect((suggestion as { items: { id: string }[] }).items.map(i => i.id)).toEqual(['item-1', 'item-2'])
  })

  it('does not leak across tenants — never falls back to the literal "self"', async () => {
    await dailyOutfitJob.execute(params, { jobId: 'j', userId: 'user-a' })

    expect(items.listItems).toHaveBeenCalledWith({}, 'user-a')
    expect(items.listItems).not.toHaveBeenCalledWith({}, 'self')
  })

  it('returns void when there is no location', async () => {
    const result = await dailyOutfitJob.execute({ locationName: 'nowhere' }, { jobId: 'j', userId: 'self' })
    expect(result).toBeUndefined()
    expect(items.listItems).not.toHaveBeenCalled()
  })

  it('propagates transient weather and AI errors to durable retry handling', async () => {
    vi.mocked(weather.getCurrentWeather).mockRejectedValueOnce(new Error('weather unavailable'))
    await expect(dailyOutfitJob.execute(params, { jobId: 'j', userId: 'user-a' }))
      .rejects.toThrow('weather unavailable')
    vi.mocked(suggest.suggestOutfits).mockRejectedValueOnce(new Error('AI unavailable'))
    await expect(dailyOutfitJob.execute(params, { jobId: 'j', userId: 'user-a' }))
      .rejects.toThrow('AI unavailable')
  })
})
