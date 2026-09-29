import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings, discoverEvents, queryEmbeddings } from '../../src/db/schema.js'
import { saveEmbedding, IMAGE_EMBED_MODEL_VERSION, TEXT_EMBED_MODEL_VERSION } from '../../src/storage/embeddings.js'
import type { Item } from '../../src/types/index.js'

// Hoisted file-scoped mocks for embed modules. The first four tests don't
// trigger embed calls (flag-off / small-closet / no-candidates short-circuit),
// so default fake implementations are safe. Happy-path tests override with
// mockResolvedValueOnce. File-scoped vi.mock isolates this from other test
// files (vi.doMock can leak when workers are reused).
vi.mock('../../src/ai/embed.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai/embed.js')>('../../src/ai/embed.js')
  return { ...actual, embedText: vi.fn(async () => new Float32Array([0, 0, 0, 0])) }
})
vi.mock('../../src/ai/embedImage.js', () => ({
  embedImage: vi.fn(async () => new Float32Array([0, 0, 0, 0])),
}))
import { embedText } from '../../src/ai/embed.js'
import { embedImage } from '../../src/ai/embedImage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
  db.delete(discoverEvents).run()
  db.delete(queryEmbeddings).run()
  vi.resetModules()
})

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: `di-${Math.random().toString(36).slice(2, 10)}`,
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
    { item_ids: ['it1', 'it2'], name: 'Mock Discover', occasion: 'casual', reasoning: 'test' },
  ],
  usage: { tokensIn: 200, tokensOut: 100 },
})

function setupMocks() {
  vi.doMock('../../src/ai/client.js', () => ({
    generateJSONWithUsage: mockGenerateJSON,
    VISION_MODEL: 'gemini-2.5-flash',
    TEXT_MODEL: 'gemini-flash-latest',
    IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
  }))
}

describe('discover pre-filter', () => {
  it('falls through to full closet when flag disabled', async () => {
    delete process.env.DISCOVER_PREFILTER_ENABLED
    setupMocks()

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    const { data: result } = await matchClosetToContext('navy linen shirt', items, undefined, 'self')
    expect(Array.isArray(result)).toBe(true)

    const events = db.select().from(discoverEvents).all()
    expect(events[0].shortlistSource).toBe('full')
    expect(events[0].preFilterEnabled).toBe(0)

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('skips pre-filter for small closets (<24 items)', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    setupMocks()

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `small-${i}` }))

    const { data: result } = await matchClosetToContext('query', items, undefined, 'self')
    expect(Array.isArray(result)).toBe(true)

    const events = db.select().from(discoverEvents).all()
    expect(events[0].shortlistSource).toBe('full')

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('falls through to full when no embeddings seeded', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    setupMocks()

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    const { data: result } = await matchClosetToContext('navy linen shirt', items, undefined, 'self')
    expect(Array.isArray(result)).toBe(true)

    const events = db.select().from(discoverEvents).all()
    expect(events[0].shortlistSource).toBe('full')

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('logs telemetry with mode, promptChars, and event shape', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    setupMocks()

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `item-${i}` }))

    await matchClosetToContext('navy linen shirt', items, undefined, 'self')

    const events = db.select().from(discoverEvents).all()
    expect(events.length).toBe(1)
    expect(events[0].mode).toBe('prompt')
    expect(events[0].itemCount).toBe(30)
    expect(events[0].preFilterEnabled).toBe(1)
    expect(events[0].promptChars).toBeGreaterThan(0)

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('sets mode to image when imageBase64 provided', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    setupMocks()

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `small-${i}` }))

    await matchClosetToContext('navy linen shirt', items, undefined, 'self', 'ZmFrZWltYWdl')

    const events = db.select().from(discoverEvents).all()
    expect(events[0].mode).toBe('image')

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('uses image shortlist when flag on, ≥24 items, and image embeddings seeded', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embedImage).mockResolvedValueOnce(new Float32Array([1, 0, 0, 0]))
    setupMocks()

    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `hp-${i}` }))
    // First 12 items aligned with query vec, rest orthogonal → topK picks the first 12
    for (let i = 0; i < 30; i++) {
      const vec = i < 12 ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 0, 1, 0])
      await saveEmbedding({
        level: 'item', refId: `hp-${i}`, userId: 'self', variant: 'image',
        modelVersion: IMAGE_EMBED_MODEL_VERSION,
        vector: vec, sourceBlob: 'test',
      })
    }

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    await matchClosetToContext('vibe', items, undefined, 'self', 'ZmFrZWltYWdl')

    const events = db.select().from(discoverEvents).all()
    expect(events[0].mode).toBe('image')
    expect(events[0].shortlistSource).toBe('image')
    expect(events[0].shortlistedCount).toBe(12)

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })

  it('uses text shortlist when flag on, ≥24 items, no image, text embeddings seeded', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embedText).mockResolvedValueOnce(new Float32Array([1, 0, 0, 0]))
    setupMocks()

    const items = Array.from({ length: 30 }, (_, i) => makeItem({ id: `ht-${i}` }))
    for (let i = 0; i < 30; i++) {
      const vec = i < 12 ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 0, 1, 0])
      await saveEmbedding({
        level: 'item', refId: `ht-${i}`, userId: 'self', variant: 'main',
        modelVersion: TEXT_EMBED_MODEL_VERSION,
        vector: vec, sourceBlob: 'test',
      })
    }

    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    await matchClosetToContext('navy linen', items, undefined, 'self')

    const events = db.select().from(discoverEvents).all()
    expect(events[0].mode).toBe('prompt')
    expect(events[0].shortlistSource).toBe('text')
    expect(events[0].shortlistedCount).toBe(12)

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })
})
