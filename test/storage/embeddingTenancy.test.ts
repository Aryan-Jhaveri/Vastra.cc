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
  getOrEmbedQuery,
  topKText,
  TEXT_EMBED_MODEL_VERSION,
} from '../../src/storage/embeddings.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
  db.delete(queryEmbeddings).run()
})

const vec = (seed: number) => new Float32Array([seed, 1 - seed, 0.5])

function record(userId: string, refId: string) {
  return {
    level: 'item' as const,
    refId,
    userId,
    variant: 'main' as const,
    modelVersion: TEXT_EMBED_MODEL_VERSION,
    vector: vec(0.5),
    sourceBlob: 'blob',
  }
}

describe('embedding tenant identity', () => {
  it('rejects a missing userId instead of defaulting to a shared tenant', async () => {
    await expect(saveEmbedding({ ...record('alice', 'i1'), userId: undefined as unknown as string }))
      .rejects.toThrow(/userId is required/)
    expect(() => getAllEmbeddings('' as string, 'item')).toThrow(/userId is required/)
    expect(() => deleteEmbedding('item', 'i1', '  ')).toThrow(/userId is required/)
  })

  it('keeps one user\'s vectors invisible to another', async () => {
    await saveEmbedding(record('alice', 'shared-id'))

    expect(getEmbedding('item', 'shared-id', 'alice')).not.toBeNull()
    expect(getEmbedding('item', 'shared-id', 'bob')).toBeNull()
    expect(getAllEmbeddings('bob', 'item').size).toBe(0)
  })

  it('does not let one user delete another user\'s vectors', async () => {
    await saveEmbedding(record('alice', 'i1'))

    deleteEmbedding('item', 'i1', 'bob')

    expect(getEmbedding('item', 'i1', 'alice')).not.toBeNull()
  })
})

describe('query embedding cache', () => {
  it('never persists the plaintext query', async () => {
    await getOrEmbedQuery('navy linen shirt', TEXT_EMBED_MODEL_VERSION, async () => vec(0.2), 'alice')

    const rows = db.select().from(queryEmbeddings).all()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0])).not.toContain('navy linen shirt')
  })

  it('scopes cache hits per user so an identical query is not shared', async () => {
    let calls = 0
    const embed = async () => { calls++; return vec(0.2) }

    await getOrEmbedQuery('same query', TEXT_EMBED_MODEL_VERSION, embed, 'alice')
    await getOrEmbedQuery('same query', TEXT_EMBED_MODEL_VERSION, embed, 'alice')
    expect(calls).toBe(1)

    await getOrEmbedQuery('same query', TEXT_EMBED_MODEL_VERSION, embed, 'bob')
    expect(calls).toBe(2)
    expect(db.select().from(queryEmbeddings).all()).toHaveLength(2)
  })

  it('requires an explicit userId', async () => {
    await expect(getOrEmbedQuery('q', TEXT_EMBED_MODEL_VERSION, async () => vec(0.2), undefined as unknown as string))
      .rejects.toThrow(/userId is required/)
  })
})

describe('topKText tenant scoping', () => {
  it('only shortlists the calling user\'s items', async () => {
    await saveEmbedding(record('alice', 'alice-item'))
    await saveEmbedding(record('bob', 'bob-item'))

    const aliceIds = await topKText('q', async () => vec(0.5), 'alice')
    const bobIds = await topKText('q', async () => vec(0.5), 'bob')

    expect(aliceIds).toEqual(['alice-item'])
    expect(bobIds).toEqual(['bob-item'])
  })
})
