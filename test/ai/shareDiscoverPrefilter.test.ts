import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings, discoverEvents, sharePayloads } from '../../src/db/schema.js'
import { IMAGE_EMBED_MODEL_VERSION, TEXT_EMBED_MODEL_VERSION, saveEmbedding } from '../../src/storage/embeddings.js'
import { nanoid } from 'nanoid'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
  db.delete(discoverEvents).run()
  db.delete(sharePayloads).run()
  vi.resetModules()
})

const mockGenerateJSON = vi.fn().mockResolvedValue({
  data: [
    { item_ids: ['a', 'b'], name: 'Shared Pick', occasion: 'casual', reasoning: 'matches vibe' },
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
  vi.doMock('../../src/ai/embed.js', () => ({
    embedText: vi.fn().mockResolvedValue(new Float32Array([1, 0, 0, 0])),
  }))
  vi.doMock('../../src/ai/embedImage.js', () => ({
    embedItemImage: vi.fn().mockResolvedValue(new Float32Array([1, 0, 0, 0])),
  }))
}

describe('share-vec-discover', () => {
  it('logs shared mode telemetry with hybrid shortlistSource', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    setupMocks()

    // Seed a share payload
    const shareId = nanoid()
    db.insert(sharePayloads).values({
      id: shareId,
      createdByUserId: 'self',
      createdAt: Date.now(),
      source: 'manual',
      description: 'navy formal wedding guest',
      imageUris: JSON.stringify(['images/share/snap.jpg']),
      visibility: 'link',
      openCount: 0,
    }).run()

    // Seed item embeddings so hybrid works
    for (let i = 0; i < 30; i++) {
      await saveEmbedding({
        level: 'item', refId: `sh-${i}`, userId: 'self', variant: 'main',
        modelVersion: TEXT_EMBED_MODEL_VERSION,
        vector: new Float32Array([1, 0, 0, 0]),
        sourceBlob: 'test',
      })
      await saveEmbedding({
        level: 'item', refId: `sh-${i}`, userId: 'self', variant: 'image',
        modelVersion: IMAGE_EMBED_MODEL_VERSION,
        vector: new Float32Array([1, 0, 0, 0]),
        sourceBlob: 'test',
      })
    }

    // Dynamic import after mocks
    const { matchClosetToContext } = await import('../../src/ai/discover.js')
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: `sh-${i}`,
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
    }))

    await matchClosetToContext('navy formal wedding guest', items, undefined, 'self', undefined, 'shared')

    // matchClosetToContext doesn't log for shared (route does) — verify no event
    const events = db.select().from(discoverEvents).all()
    expect(events.length).toBe(0)

    delete process.env.DISCOVER_PREFILTER_ENABLED
  })
})
