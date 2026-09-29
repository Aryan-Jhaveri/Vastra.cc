import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings } from '../../src/db/schema.js'
import {
  topKText,
  topKImage,
  topKHybrid,
  shouldUsePreFilter,
  IMAGE_EMBED_MODEL_VERSION,
  TEXT_EMBED_MODEL_VERSION,
  saveEmbedding,
} from '../../src/storage/embeddings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
})

function makeVec(values: number[]): Float32Array {
  return new Float32Array(values)
}

const mockTextEmbed = vi.fn(async (text: string) => {
  if (text === 'query zero') return makeVec([0, 0, 0, 0])
  return makeVec([1, 0, 0, 0])
})

const mockImageEmbed = vi.fn(async (_uri: string, _userId: string) => {
  return makeVec([0, 1, 0, 0])
})

describe('shouldUsePreFilter', () => {
  it('returns true when items >= 24', () => {
    expect(shouldUsePreFilter(24)).toBe(true)
    expect(shouldUsePreFilter(100)).toBe(true)
  })

  it('returns false when items < 24', () => {
    expect(shouldUsePreFilter(23)).toBe(false)
    expect(shouldUsePreFilter(0)).toBe(false)
  })
})

describe('topKText', () => {
  it('returns item ids sorted by cosine similarity', async () => {
    await saveEmbedding({
      level: 'item', refId: 'match', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([1, 0, 0, 0]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'far', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([0, 0, 1, 0]), sourceBlob: 'test',
    })

    const result = await topKText('query', mockTextEmbed, 'self')
    expect(result).toEqual(['match', 'far'])
  })

  it('returns empty when no candidates', async () => {
    const result = await topKText('query', mockTextEmbed, 'self')
    expect(result).toEqual([])
  })
})

describe('topKImage', () => {
  it('returns item ids by image similarity', async () => {
    await saveEmbedding({
      level: 'item', refId: 'img-match', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0, 1, 0, 0]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'img-far', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0, 0, 1, 0]), sourceBlob: 'test',
    })

    const result = await topKImage('images/fake.jpg', mockImageEmbed, 'self')
    expect(result).toEqual(['img-match', 'img-far'])
  })

  it('passes userId to imageEmbedFn', async () => {
    await saveEmbedding({
      level: 'item', refId: 'uid-test', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0, 1, 0, 0]), sourceBlob: 'test',
      userId: 'alice',
    })
    const customMock = vi.fn(async (_uri: string, _userId: string) => {
      return makeVec([0, 1, 0, 0])
    })
    await topKImage('images/fake.jpg', customMock, 'alice')
    expect(customMock).toHaveBeenCalledWith('images/fake.jpg', 'alice')
  })
})

describe('topKHybrid', () => {
  it('merges text and image ranks via RRF', async () => {
    await saveEmbedding({
      level: 'item', refId: 'both', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([1, 0, 0, 0]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'both', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0, 1, 0, 0]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'text-only', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([0.9, 0, 0, 0]), sourceBlob: 'test',
    })

    const result = await topKHybrid('query', mockTextEmbed, 'images/fake.jpg', mockImageEmbed, 'self')
    expect(result).toContain('both')
  })

  it('falls back to text-only when no image query', async () => {
    await saveEmbedding({
      level: 'item', refId: 't1', userId: 'self', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([1, 0, 0, 0]), sourceBlob: 'test',
    })

    const result = await topKHybrid('query', mockTextEmbed, undefined, mockImageEmbed, 'self')
    expect(result).toEqual(['t1'])
  })

  it('passes userId to imageEmbedFn', async () => {
    await saveEmbedding({
      level: 'item', refId: 'hb-uid', variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: makeVec([1, 0, 0, 0]), sourceBlob: 'test',
      userId: 'bob',
    })
    await saveEmbedding({
      level: 'item', refId: 'hb-uid', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0, 1, 0, 0]), sourceBlob: 'test',
      userId: 'bob',
    })
    const customMock = vi.fn(async (_uri: string, _userId: string) => {
      return makeVec([0, 1, 0, 0])
    })
    await topKHybrid('query', mockTextEmbed, 'images/fake.jpg', customMock, 'bob')
    expect(customMock).toHaveBeenCalledWith('images/fake.jpg', 'bob')
  })
})
