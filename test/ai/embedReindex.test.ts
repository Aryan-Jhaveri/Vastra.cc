import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../src/db/client.js'
import { embeddings, items, outfits, sharePayloads } from '../../src/db/schema.js'
import { saveEmbedding, TEXT_EMBED_MODEL_VERSION, IMAGE_EMBED_MODEL_VERSION } from '../../src/storage/embeddings.js'
import { __resetReembedJob, embeddingStatus, pruneSuperseded, startReembed } from '../../src/ai/embedReindex.js'

// #353 — re-embed after a model switch: counts, a resumable background pass,
// and pruning of rows from the previous model.
function seedItem(id: string) {
  db.insert(items).values({ id, userId: 'self', imageUri: 'images/items/x.jpg', category: 'tops', createdAt: Date.now(), updatedAt: Date.now() }).run()
}
const vec = new Float32Array([1, 0])

beforeEach(() => {
  __resetReembedJob()
  db.delete(embeddings).run()
  db.delete(items).run()
  db.delete(outfits).run()
  db.delete(sharePayloads).run()
  vi.stubEnv('TEXT_EMBED_ENABLED', 'true')
  vi.stubEnv('IMAGE_EMBED_ENABLED', '')
  vi.stubEnv('MOCK_EMBEDDINGS', 'true')
})
afterEach(() => vi.unstubAllEnvs())

async function waitForJob() {
  for (let i = 0; i < 200 && embeddingStatus().job.running; i++) await new Promise(r => setTimeout(r, 10))
}

describe('embedding re-index', () => {
  it('reports coverage and superseded rows per model', async () => {
    seedItem('i1'); seedItem('i2')
    await saveEmbedding({ level: 'item', refId: 'i1', userId: 'self', variant: 'main', modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: '' })
    await saveEmbedding({ level: 'item', refId: 'i2', userId: 'self', variant: 'main', modelVersion: 'old@768', vector: vec, sourceBlob: '' })
    await saveEmbedding({ level: 'item', refId: 'i2', userId: 'self', variant: 'image', modelVersion: 'old-img@1408', vector: vec, sourceBlob: '' })
    const s = embeddingStatus()
    expect(s.text).toMatchObject({ enabled: true, modelVersion: TEXT_EMBED_MODEL_VERSION, items: { total: 2, current: 1 }, superseded: 1 })
    expect(s.image).toMatchObject({ enabled: false, modelVersion: IMAGE_EMBED_MODEL_VERSION, superseded: 1 })
    expect(s.job.running).toBe(false)
  })

  it('a pass fills in missing current-model vectors; a second start while running is refused', async () => {
    seedItem('i1'); seedItem('i2')
    expect(startReembed()).toBe(true)
    expect(startReembed()).toBe(false)
    await waitForJob()
    const s = embeddingStatus()
    expect(s.text.items).toEqual({ total: 2, current: 2 })
    expect(s.job).toMatchObject({ running: false, embedded: 2, error: null })
  })

  it('prune refuses before coverage is complete unless forced, then deletes only superseded rows', async () => {
    seedItem('i1'); seedItem('i2')
    await saveEmbedding({ level: 'item', refId: 'i1', userId: 'self', variant: 'main', modelVersion: 'old@768', vector: vec, sourceBlob: '' })
    expect(pruneSuperseded()).toEqual({ ok: false, reason: 'incomplete' })

    startReembed()
    await waitForJob()
    expect(pruneSuperseded()).toEqual({ ok: true, deleted: 1 })
    expect(embeddingStatus().text).toMatchObject({ items: { total: 2, current: 2 }, superseded: 0 })
  })

  it('force prunes even when incomplete', async () => {
    seedItem('i1')
    await saveEmbedding({ level: 'item', refId: 'i1', userId: 'self', variant: 'main', modelVersion: 'old@768', vector: vec, sourceBlob: '' })
    expect(pruneSuperseded({ force: true })).toEqual({ ok: true, deleted: 1 })
  })
})
