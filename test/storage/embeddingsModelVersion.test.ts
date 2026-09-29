import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../src/db/client.js'
import { embeddings } from '../../src/db/schema.js'
import {
  getAllEmbeddings, getEmbedding, IMAGE_EMBED_MODEL_VERSION, modelVersionForVariant, saveEmbedding, TEXT_EMBED_MODEL_VERSION,
} from '../../src/storage/embeddings.js'

// #353 — after an embedding model/dimension switch, rows from the previous
// model stay in the table until pruned. Reads must only return rows from the
// current model, or retrieval compares vectors from two different spaces.
const OLD = 'old-model@1408'
const save = (refId: string, variant: 'main' | 'image', modelVersion: string, userId = 'self') =>
  saveEmbedding({ level: 'item', refId, userId, variant, modelVersion, vector: new Float32Array([1, 0]), sourceBlob: '' })

beforeEach(() => {
  db.delete(embeddings).run()
})

describe('model version on read', () => {
  it('maps image variants to the image model and the rest to the text model', () => {
    expect(modelVersionForVariant('image_cover')).toBe(IMAGE_EMBED_MODEL_VERSION)
    expect(modelVersionForVariant('image_centroid')).toBe(IMAGE_EMBED_MODEL_VERSION)
    expect(modelVersionForVariant('metadata')).toBe(TEXT_EMBED_MODEL_VERSION)
  })

  it('getAllEmbeddings ignores superseded rows', async () => {
    await save('a', 'main', TEXT_EMBED_MODEL_VERSION)
    await save('b', 'main', OLD)
    await save('c', 'image', IMAGE_EMBED_MODEL_VERSION)
    await save('d', 'image', OLD)
    expect([...getAllEmbeddings('self', 'item', 'main').keys()]).toEqual(['a'])
    expect([...getAllEmbeddings('self', 'item', 'image').keys()]).toEqual(['c'])
    expect([...getAllEmbeddings('self', 'item').keys()].sort()).toEqual(['a', 'c'])
  })

  it('getEmbedding returns the current row, or null when only an old one exists', async () => {
    await save('x', 'image', OLD)
    expect(getEmbedding('item', 'x', 'self', 'image')).toBeNull()
    await save('x', 'image', IMAGE_EMBED_MODEL_VERSION)
    expect(getEmbedding('item', 'x', 'self', 'image')).not.toBeNull()
  })
})
