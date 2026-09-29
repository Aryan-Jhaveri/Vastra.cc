import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings, suggestEvents } from '../../src/db/schema.js'
import { TEXT_EMBED_MODEL_VERSION, saveEmbedding } from '../../src/storage/embeddings.js'
import type { WeatherData, Item } from '../../src/types/index.js'

vi.mock('../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn((input: any) => input.call({}).then((r: any) => r.result)),
}))

const __dirname = dirname(fileURLToPath(import.meta.url))

// Scope every row this file writes/reads to a unique userId so parallel test
// files (e.g. test/ai/suggest.test.ts) writing to the shared /tmp closet.db
// don't race into our suggest_events assertions.
const TEST_USER = 'prefilter-test'

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).where(eq(embeddings.userId, TEST_USER)).run()
  db.delete(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).run()
  vi.resetModules()
})

const weather: WeatherData = {
  temperature: 22,
  weatherCode: 1,
  condition: 'Sunny',
  precipitation: 0,
  windSpeed: 10,
  icon: 'sunny',
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: `item-${Math.random().toString(36).slice(2, 10)}`,
    imageUri: 'images/items/test.jpg',
    category: 'tops',
    subcategory: 't-shirt',
    primaryColor: 'blue',
    colors: '["blue"]',
    material: 'cotton',
    brand: null,
    size: null,
    season: '["summer"]',
    tags: '["casual"]',
    aiDescription: null,
    occasion: '["casual"]',
    wearContext: null,
    materialSource: null,
    careInstructions: '[]',
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tagImageUri: null,
    ...overrides,
  } as Item
}

const mockGenerateJSON = vi.fn().mockResolvedValue({
  data: [
    { item_ids: ['it1', 'it2'], name: 'Mock Outfit', occasion: 'casual', reasoning: 'test' },
  ],
  usage: { tokensIn: 200, tokensOut: 100 },
})

function setupClientMock() {
  vi.doMock('../../src/ai/client.js', () => ({
    generateJSONWithUsage: mockGenerateJSON,
    VISION_MODEL: 'gemini-2.5-flash',
    TEXT_MODEL: 'gemini-flash-latest',
    IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
  }))
}

describe('suggestOutfits with pre-filter', () => {
  const userEvents = () =>
    db.select().from(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).all()

  it('uses full closet when flag is disabled', async () => {
    delete process.env.SUGGEST_PREFILTER_ENABLED
    setupClientMock()

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    const result = await suggestOutfits(weather, items, TEST_USER)
    expect(Array.isArray(result)).toBe(true)

    const events = userEvents()
    expect(events[0].shortlistSource).toBe('full')
    expect(events[0].preFilterEnabled).toBe(0)

    delete process.env.SUGGEST_PREFILTER_ENABLED
  })

  it('falls through to full closet when no embeddings seeded', async () => {
    process.env.SUGGEST_PREFILTER_ENABLED = 'true'
    setupClientMock()

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    const result = await suggestOutfits(weather, items, TEST_USER)
    expect(Array.isArray(result)).toBe(true)

    const events = userEvents()
    expect(events[0].shortlistSource).toBe('full')

    delete process.env.SUGGEST_PREFILTER_ENABLED
  })

  it('skips pre-filter for small closets (<24 items)', async () => {
    process.env.SUGGEST_PREFILTER_ENABLED = 'true'
    setupClientMock()

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `item-${i}` }))

    const result = await suggestOutfits(weather, items, TEST_USER)
    expect(Array.isArray(result)).toBe(true)

    const events = userEvents()
    expect(events[0].shortlistSource).toBe('full')

    delete process.env.SUGGEST_PREFILTER_ENABLED
  })

  it('logs telemetry with correct event shape', async () => {
    process.env.SUGGEST_PREFILTER_ENABLED = 'true'
    setupClientMock()

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    await suggestOutfits(weather, items, TEST_USER)

    const events = userEvents()
    expect(events.length).toBe(1)
    expect(events[0].shortlistSource).toBe('full') // full coz no embeddings
    expect(events[0].itemCount).toBe(30)
    expect(events[0].preFilterEnabled).toBe(1)
    expect(events[0].userId).toBe(TEST_USER)

    delete process.env.SUGGEST_PREFILTER_ENABLED
  })

  it('logs prompt_chars and full event shape when embeddings present', async () => {
    process.env.SUGGEST_PREFILTER_ENABLED = 'true'
    setupClientMock()

    // Seed embeddings so the pre-filter path is entered (even though embedText
    // will fail without a real API key, which triggers the graceful fallback).
    for (let i = 0; i < 30; i++) {
      await saveEmbedding({
        level: 'item', refId: `hit-${i}`, userId: TEST_USER, variant: 'main',
        modelVersion: TEXT_EMBED_MODEL_VERSION,
        vector: new Float32Array([1, 0, 0, 0]),
        sourceBlob: 'test',
      })
    }

    const { suggestOutfits } = await import('../../src/ai/suggest.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `hit-${i}` }))

    const result = await suggestOutfits(weather, items, TEST_USER)
    expect(Array.isArray(result)).toBe(true)

    const events = userEvents()
    expect(events.length).toBe(1)
    expect(events[0].itemCount).toBe(30)
    expect(events[0].preFilterEnabled).toBe(1)
    // prompt_chars is always populated regardless of shortlist path
    expect(events[0].promptChars).toBeGreaterThan(0)

    delete process.env.SUGGEST_PREFILTER_ENABLED
  })
})
