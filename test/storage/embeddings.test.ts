import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings, queryEmbeddings } from '../../src/db/schema.js'
import {
  saveEmbedding,
  getEmbedding,
  getAllEmbeddings,
  deleteEmbedding,
  deleteEmbeddingVariant,
  cosineSim,
  topK,
  centroid,
  l2Normalize,
  reciprocalRankFusion,
  getRrfRanks,
  IMAGE_EMBED_MODEL_VERSION,
} from '../../src/storage/embeddings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
  db.delete(queryEmbeddings).run()
})

function makeVec(values: number[]): Float32Array {
  return new Float32Array(values)
}

function float32Equal(a: Float32Array, b: Float32Array, epsilon = 0.0001): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > epsilon) return false
  }
  return true
}

describe('embeddings storage', () => {
  it('saveEmbedding creates a new row', async () => {
    const vec = makeVec([0.1, 0.2, 0.3, 0.4])
    await saveEmbedding({
      level: 'item',
      refId: 'test-item-1', userId: 'self',
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: 'tops | t-shirt | blue',
    })

    const retrieved = getEmbedding('item', 'test-item-1', 'self', 'image')
    expect(retrieved).not.toBeNull()
    expect(float32Equal(retrieved!, vec)).toBe(true)
  })

  it('saveEmbedding updates an existing row (same unique key)', async () => {
    const vec1 = makeVec([0.1, 0.2, 0.3, 0.4])
    const vec2 = makeVec([0.5, 0.6, 0.7, 0.8])

    await saveEmbedding({
      level: 'item',
      refId: 'test-item-2', userId: 'self',
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec1,
      sourceBlob: 'old blob',
    })

    await saveEmbedding({
      level: 'item',
      refId: 'test-item-2', userId: 'self',
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec2,
      sourceBlob: 'new blob',
    })

    const retrieved = getEmbedding('item', 'test-item-2', 'self', 'image')
    expect(retrieved).not.toBeNull()
    expect(float32Equal(retrieved!, vec2)).toBe(true)
  })

  it('getEmbedding returns null for missing', () => {
    const result = getEmbedding('item', 'nonexistent', 'self', 'image')
    expect(result).toBeNull()
  })

  it('getAllEmbeddings returns all for a level', async () => {
    await saveEmbedding({
      level: 'item',
      refId: 'item-a', userId: 'self',
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.1, 0.2]),
      sourceBlob: 'a',
    })
    await saveEmbedding({
      level: 'item',
      refId: 'item-b', userId: 'self',
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.3, 0.4]),
      sourceBlob: 'b',
    })

    const all = getAllEmbeddings('self', 'item', 'image')
    expect(all.size).toBeGreaterThanOrEqual(2)
    expect(all.has('item-a')).toBe(true)
    expect(all.has('item-b')).toBe(true)
  })

  it('deleteEmbedding removes all variants for a ref', async () => {
    await saveEmbedding({
      level: 'item', refId: 'to-delete', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.1, 0.2]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'to-delete', userId: 'self', variant: 'main',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.3, 0.4]), sourceBlob: 'test',
    })

    deleteEmbedding('item', 'to-delete', 'self')

    expect(getEmbedding('item', 'to-delete', 'self', 'image')).toBeNull()
    expect(getEmbedding('item', 'to-delete', 'self', 'main')).toBeNull()
  })

  it('deleteEmbeddingVariant removes only specific variant', async () => {
    await saveEmbedding({
      level: 'item', refId: 'variant-test', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.1, 0.2]), sourceBlob: 'test',
    })
    await saveEmbedding({
      level: 'item', refId: 'variant-test', userId: 'self', variant: 'image_cover',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: makeVec([0.3, 0.4]), sourceBlob: 'test',
    })

    deleteEmbeddingVariant('item', 'variant-test', 'image', 'self')

    expect(getEmbedding('item', 'variant-test', 'self', 'image')).toBeNull()
    expect(getEmbedding('item', 'variant-test', 'self', 'image_cover')).not.toBeNull()
  })
})

describe('cosineSim', () => {
  it('returns 1 for identical vectors', () => {
    const a = makeVec([1, 2, 3])
    expect(cosineSim(a, a)).toBeCloseTo(1, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = makeVec([1, 0, 0])
    const b = makeVec([0, 1, 0])
    expect(cosineSim(a, b)).toBeCloseTo(0, 5)
  })

  it('returns 0 for zero vectors', () => {
    const a = makeVec([0, 0, 0])
    const b = makeVec([1, 2, 3])
    expect(cosineSim(a, b)).toBe(0)
  })

  it('throws on dimension mismatch', () => {
    const a = makeVec([1, 2])
    const b = makeVec([1, 2, 3])
    expect(() => cosineSim(a, b)).toThrow('Vector dimension mismatch')
  })
})

describe('topK', () => {
  it('returns top K ids sorted by cosine similarity', () => {
    const query = makeVec([1, 0, 0])
    const candidates = new Map<string, Float32Array>([
      ['a', makeVec([1, 0, 0])],
      ['b', makeVec([0, 1, 0])],
      ['c', makeVec([0.9, 0.1, 0])],
    ])
    const result = topK(query, candidates, 2)
    expect(result).toEqual(['a', 'c'])
  })

  it('returns all when k > candidates', () => {
    const query = makeVec([1, 0, 0])
    const candidates = new Map<string, Float32Array>([['a', makeVec([1, 0, 0])]])
    const result = topK(query, candidates, 5)
    expect(result).toEqual(['a'])
  })
})

describe('centroid', () => {
  it('computes mean of vectors and L2 normalises', () => {
    const vecs = [
      makeVec([1, 0, 0]),
      makeVec([0, 1, 0]),
    ]
    const c = centroid(vecs)
    expect(c.length).toBe(3)
    const norm = Math.sqrt(c[0] ** 2 + c[1] ** 2 + c[2] ** 2)
    expect(norm).toBeCloseTo(1, 5)
  })

  it('throws on empty input', () => {
    expect(() => centroid([])).toThrow('Cannot compute centroid of empty set')
  })
})

describe('l2Normalize', () => {
  it('normalizes to unit length', () => {
    const vec = makeVec([3, 4, 0])
    const n = l2Normalize(vec)
    expect(n[0]).toBeCloseTo(0.6, 5)
    expect(n[1]).toBeCloseTo(0.8, 5)
    expect(n[2]).toBeCloseTo(0, 5)
  })

  it('returns zero vector unchanged', () => {
    const vec = makeVec([0, 0, 0])
    const n = l2Normalize(vec)
    expect(float32Equal(vec, n)).toBe(true)
  })
})

describe('reciprocalRankFusion', () => {
  it('merges text and image ranks with RRF', () => {
    const textRanks = new Map([['a', 0], ['b', 1]])
    const imageRanks = new Map([['c', 0], ['a', 1]])
    const result = reciprocalRankFusion(textRanks, imageRanks, 3)
    expect([...result.keys()]).toEqual(['a', 'c', 'b'])
  })

  it('returns text-only results when no image ranks', () => {
    const textRanks = new Map([['a', 0], ['b', 1]])
    const result = reciprocalRankFusion(textRanks, new Map(), 2)
    expect([...result.keys()]).toEqual(['a', 'b'])
  })
})

describe('getRrfRanks', () => {
  it('returns rank positions based on cosine similarity', () => {
    const query = makeVec([1, 0, 0])
    const candidates = new Map<string, Float32Array>([
      ['best', makeVec([1, 0, 0])],
      ['worst', makeVec([0, 1, 0])],
    ])
    const ranks = getRrfRanks(candidates, query)
    expect(ranks.get('best')).toBe(0)
    expect(ranks.get('worst')).toBe(1)
  })
})
