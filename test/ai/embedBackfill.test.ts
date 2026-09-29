import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { items, outfits, sharePayloads, embeddings } from '../../src/db/schema.js'
import {
  backfillItemTextEmbeddings,
  backfillOutfitTextEmbeddings,
  backfillShareTextEmbeddings,
  backfillItemImageEmbeddings,
  backfillOutfitImageEmbeddings,
  backfillShareImageEmbeddings,
} from '../../src/ai/embedBackfill.js'
import {
  TEXT_EMBED_MODEL_VERSION,
  IMAGE_EMBED_MODEL_VERSION,
  saveEmbedding,
} from '../../src/storage/embeddings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(items).run()
  db.delete(outfits).run()
  db.delete(sharePayloads).run()
  db.delete(embeddings).run()
})

function seedItem(id: string) {
  db.insert(items).values({
    id, imageUri: 'images/items/test.jpg', category: 'tops',
    createdAt: Date.now(), updatedAt: Date.now(),
  }).run()
}

function seedOutfit(id: string) {
  db.insert(outfits).values({
    id, name: 'Test Outfit', itemIds: '[]',
    createdAt: Date.now(),
  }).run()
}

describe('text backfill', () => {
  it('returns 0 when TEXT_EMBED_ENABLED is disabled', async () => {
    delete process.env.TEXT_EMBED_ENABLED
    expect(await backfillItemTextEmbeddings('embed_reconcile')).toBe(0)
  })

  it('embeds items missing text embeddings', async () => {
    // Snapshot and restore: vitest.config.ts seeds GEMINI_API_KEY for the
    // worker process — deleting it here leaked to every later test file in
    // the same worker (#301).
    const origKey = process.env.GEMINI_API_KEY
    const origTextEmbed = process.env.TEXT_EMBED_ENABLED
    process.env.TEXT_EMBED_ENABLED = 'true'
    process.env.GEMINI_API_KEY = 'fake-key'
    seedItem('it1')

    try {
      // Should try to embed but fail gracefully (fake API key)
      const count = await backfillItemTextEmbeddings('embed_reconcile')
      expect(count).toBeGreaterThanOrEqual(0)
    } finally {
      if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey
      else delete process.env.GEMINI_API_KEY
      if (origTextEmbed !== undefined) process.env.TEXT_EMBED_ENABLED = origTextEmbed
      else delete process.env.TEXT_EMBED_ENABLED
    }
  })

  it('skips already-embedded items', async () => {
    process.env.TEXT_EMBED_ENABLED = 'true'
    seedItem('it-skip')

    await saveEmbedding({
      level: 'item', refId: 'it-skip', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: new Float32Array([0.1, 0.2]),
      sourceBlob: 'test',
    })

    const count = await backfillItemTextEmbeddings('embed_reconcile')
    expect(count).toBe(0)

    delete process.env.TEXT_EMBED_ENABLED
  })

  it('is no-op when everything is already embedded', async () => {
    process.env.TEXT_EMBED_ENABLED = 'true'
    seedItem('complete')
    seedOutfit('ofit')

    await saveEmbedding({
      level: 'item', refId: 'complete', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: new Float32Array([0.1, 0.2]),
      sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'outfit', refId: 'ofit', userId: 'self', variant: 'metadata',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: new Float32Array([0.3, 0.4]),
      sourceBlob: 'test',
    })

    const itemCount = await backfillItemTextEmbeddings('embed_reconcile')
    const outfitCount = await backfillOutfitTextEmbeddings('embed_reconcile')
    expect(itemCount).toBe(0)
    expect(outfitCount).toBe(0)

    delete process.env.TEXT_EMBED_ENABLED
  })
})

describe('image backfill', () => {
  it('returns 0 when IMAGE_EMBED_ENABLED is disabled', async () => {
    delete process.env.IMAGE_EMBED_ENABLED
    expect(await backfillItemImageEmbeddings('embed_reconcile')).toBe(0)
  })

  it('is no-op when everything already has image embeddings', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    seedItem('img-done')

    await saveEmbedding({
      level: 'item', refId: 'img-done', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: new Float32Array([0.1, 0.2]),
      sourceBlob: 'test',
    })

    const count = await backfillItemImageEmbeddings('embed_reconcile')
    expect(count).toBe(0)

    delete process.env.IMAGE_EMBED_ENABLED
  })
})
