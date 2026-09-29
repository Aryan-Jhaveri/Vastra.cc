import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { embeddings } from '../../src/db/schema.js'

vi.hoisted(() => {
  process.env.GCP_PROJECT_ID = 'test-project'
  process.env.GCP_LOCATION = 'us-west1'
  process.env.GEMINI_API_KEY = 'test-key'
})

const { mockFetch } = vi.hoisted(() => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ predictions: [{ imageEmbedding: [0.1, 0.2, 0.3, 0.4] }] }),
    text: async () => '',
  })
  return { mockFetch }
})

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    this.models = { embedContent: vi.fn() }
  }),
}))

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function () {
    this.getAccessToken = vi.fn().mockResolvedValue('test-access-token')
  }),
  OAuth2Client: vi.fn(),
}))

vi.stubGlobal('fetch', mockFetch)

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
}))

import {
  itemSourceBlob,
  outfitMetadataSourceBlob,
  embedItemOnSave,
  embedOutfitCoverOnSave,
  embedOutfitCentroidOnSave,
  embedShareImageOnSave,
} from '../../src/ai/embedImage.js'
import { IMAGE_EMBED_MODEL_VERSION, getEmbedding, saveEmbedding } from '../../src/storage/embeddings.js'
import * as images from '../../src/storage/images.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
  mockFetch.mockClear()
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ predictions: [{ imageEmbedding: [0.1, 0.2, 0.3, 0.4] }] }),
    text: async () => '',
  })
})

describe('itemSourceBlob', () => {
  it('concatenates all item fields with pipe separators', () => {
    const blob = itemSourceBlob({
      category: 'tops',
      subcategory: 't-shirt',
      primaryColor: 'blue',
      colors: '["blue","white"]',
      material: 'cotton',
      brand: 'Nike',
      size: 'M',
      season: '["summer"]',
      tags: '["casual"]',
      aiDescription: 'A comfortable blue t-shirt',
      occasion: '["casual"]',
      wearContext: 'summer casual wear',
    })
    expect(blob).toContain('tops')
    expect(blob).toContain('t-shirt')
    expect(blob).toContain('blue')
    expect(blob).toContain('cotton')
    expect(blob).toContain('Nike')
    expect(blob).toContain('M')
    expect(blob).toContain('summer casual wear')
    expect(blob.split(' | ').length).toBe(12)
  })

  it('handles null/undefined fields', () => {
    const blob = itemSourceBlob({ category: 'shoes' })
    expect(blob.split(' | ')).toEqual(['shoes', '', '', '', '', '', '', '', '', '', '', ''])
  })
})

describe('outfitMetadataSourceBlob', () => {
  it('concatenates outfit metadata fields', () => {
    const blob = outfitMetadataSourceBlob({
      name: 'Summer Casual',
      occasion: 'casual',
      season: '["summer"]',
      notes: 'beach day',
      tags: '["light"]',
    })
    expect(blob).toContain('Summer Casual')
    expect(blob).toContain('casual')
    expect(blob).toContain('summer')
    expect(blob).toContain('beach day')
  })
})

// ─── Disabled path ─────────────────────────────────────────────────────────────

describe('disabled when IMAGE_EMBED_ENABLED is not set', () => {
  it('all four helpers are no-ops regardless of userId', async () => {
    delete process.env.IMAGE_EMBED_ENABLED

    await embedItemOnSave({ id: 'd1', imageUri: 'images/items/fake.jpg', category: 'tops' }, 'alice')
    await embedOutfitCoverOnSave({ id: 'd2', coverImageUri: 'images/outfits/fake.jpg' }, 'alice')
    await embedOutfitCentroidOnSave({ id: 'd3', itemIds: '["i1"]' }, 'alice')
    await embedShareImageOnSave({ id: 'd4', description: 'test', imageUris: '["images/share/fake.jpg"]' }, 'alice')

    const rows = db.select({ id: embeddings.id }).from(embeddings).all()
    expect(rows.length).toBe(0)
  })
})

// ─── embedItemOnSave ───────────────────────────────────────────────────────────

describe('embedItemOnSave', () => {
  it('passes userId to resolveImagePath', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    const spy = vi.spyOn(images, 'resolveImagePath')

    await embedItemOnSave({
      id: 'test-resolve',
      imageUri: 'images/items/fake.jpg',
      category: 'tops',
    }, 'alice')

    expect(spy).toHaveBeenCalledWith('images/items/fake.jpg', 'alice')
    spy.mockRestore()
    delete process.env.IMAGE_EMBED_ENABLED
  })

  it('saves embedding under correct userId (cross-user isolation)', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'

    await embedItemOnSave({
      id: 'test-isolation',
      imageUri: 'images/items/fake.jpg',
      category: 'tops',
    }, 'alice')

    const aliceEmbed = getEmbedding('item', 'test-isolation', 'alice', 'image')
    expect(aliceEmbed).not.toBeNull()
    expect(aliceEmbed!.length).toBe(4)

    const bobEmbed = getEmbedding('item', 'test-isolation', 'bob', 'image')
    expect(bobEmbed).toBeNull()

    delete process.env.IMAGE_EMBED_ENABLED
  })
})

// ─── embedOutfitCoverOnSave ────────────────────────────────────────────────────

describe('embedOutfitCoverOnSave', () => {
  it('skips when coverImageUri is null', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    await expect(embedOutfitCoverOnSave({
      id: 'test-outfit',
      coverImageUri: null,
    }, 'alice')).resolves.toBeUndefined()
    delete process.env.IMAGE_EMBED_ENABLED
  })

  it('saves cover embedding under correct userId (cross-user isolation)', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'

    await embedOutfitCoverOnSave({
      id: 'cover-isolation',
      coverImageUri: 'images/outfits/fake.jpg',
      name: 'Casual Fit',
    }, 'alice')

    const aliceEmbed = getEmbedding('outfit', 'cover-isolation', 'alice', 'image_cover')
    expect(aliceEmbed).not.toBeNull()
    expect(aliceEmbed!.length).toBe(4)

    const bobEmbed = getEmbedding('outfit', 'cover-isolation', 'bob', 'image_cover')
    expect(bobEmbed).toBeNull()

    delete process.env.IMAGE_EMBED_ENABLED
  })
})

// ─── embedOutfitCentroidOnSave ─────────────────────────────────────────────────

describe('embedOutfitCentroidOnSave', () => {
  it('skips when no item image embeddings exist for the given user', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    await expect(embedOutfitCentroidOnSave({
      id: 'test-centroid-skip',
      itemIds: '["nonexistent-item"]',
    }, 'alice')).resolves.toBeUndefined()
    delete process.env.IMAGE_EMBED_ENABLED
  })

  it('computes centroid from the correct userId vectors (not self)', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    const aliceVec1 = new Float32Array([0.2, 0.4, 0.6, 0.8])
    const aliceVec2 = new Float32Array([0.8, 0.6, 0.4, 0.2])
    const selfVec1 = new Float32Array([0.9, 0.9, 0.9, 0.9])
    const selfVec2 = new Float32Array([0.1, 0.1, 0.1, 0.1])

    await saveEmbedding({
      level: 'item', refId: 'item-cent-1', userId: 'alice', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: aliceVec1, sourceBlob: 'alice1',
    })
    await saveEmbedding({
      level: 'item', refId: 'item-cent-2', userId: 'alice', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: aliceVec2, sourceBlob: 'alice2',
    })
    // Seed 'self' vectors under different item IDs to avoid the UNIQUE index
    // (idx_embeddings_unique is on (level, ref_id, variant, model_version) without user_id)
    await saveEmbedding({
      level: 'item', refId: 'item-cent-self-1', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: selfVec1, sourceBlob: 'self1',
    })
    await saveEmbedding({
      level: 'item', refId: 'item-cent-self-2', userId: 'self', variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: selfVec2, sourceBlob: 'self2',
    })

    await embedOutfitCentroidOnSave({
      id: 'outfit-cent-test',
      itemIds: JSON.stringify(['item-cent-1', 'item-cent-2']),
    }, 'alice')

    const centroidVec = getEmbedding('outfit', 'outfit-cent-test', 'alice', 'image_centroid')
    expect(centroidVec).not.toBeNull()
    expect(centroidVec!.length).toBe(4)

    // Centroid should equal the mean of alice's vectors: [(0.2+0.8)/2, (0.4+0.6)/2, (0.6+0.4)/2, (0.8+0.2)/2] = [0.5, 0.5, 0.5, 0.5]
    expect(centroidVec![0]).toBeCloseTo(0.5)
    expect(centroidVec![1]).toBeCloseTo(0.5)
    expect(centroidVec![2]).toBeCloseTo(0.5)
    expect(centroidVec![3]).toBeCloseTo(0.5)

    // self user should NOT have the centroid
    const selfCentroid = getEmbedding('outfit', 'outfit-cent-test', 'self', 'image_centroid')
    expect(selfCentroid).toBeNull()

    delete process.env.IMAGE_EMBED_ENABLED
  })
})

// ─── embedShareImageOnSave ─────────────────────────────────────────────────────

describe('embedShareImageOnSave', () => {
  it('skips when no image uris', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'
    await expect(embedShareImageOnSave({
      id: 'test-share-empty',
      description: 'test',
      imageUris: '[]',
    }, 'alice')).resolves.toBeUndefined()
    delete process.env.IMAGE_EMBED_ENABLED
  })

  it('saves share embedding under correct userId (cross-user isolation)', async () => {
    process.env.IMAGE_EMBED_ENABLED = 'true'

    await embedShareImageOnSave({
      id: 'share-isolation',
      description: 'Summer look',
      imageUris: '["images/share/fake.jpg"]',
    }, 'alice')

    const aliceEmbed = getEmbedding('share', 'share-isolation', 'alice', 'image_snapshot')
    expect(aliceEmbed).not.toBeNull()
    expect(aliceEmbed!.length).toBe(4)

    const bobEmbed = getEmbedding('share', 'share-isolation', 'bob', 'image_snapshot')
    expect(bobEmbed).toBeNull()

    delete process.env.IMAGE_EMBED_ENABLED
  })
})

// ─── Vertex routing ───────────────────────────────────────────────────────────

describe('vertex routing', () => {
  it('embedImage returns vector of IMAGE_EMBED_DIM length', async () => {
    const dim = 1408
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ predictions: [{ imageEmbedding: new Array(dim).fill(0.1) }] }),
      text: async () => '',
    })

    const { embedImage } = await import('../../src/ai/embedImage.js')
    const vec = await embedImage(Buffer.from('test'))

    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(dim)
  })

  it('embedImage POSTs to the Vertex predict endpoint with instances[]', async () => {
    const { embedImage } = await import('../../src/ai/embedImage.js')
    await embedImage(Buffer.from('hello'))

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/us-west1-aiplatform\.googleapis\.com.*multimodalembedding@001:predict$/)
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer test-access-token')
    const body = JSON.parse(init.body)
    expect(body.instances?.[0]?.image?.bytesBase64Encoded).toBe(Buffer.from('hello').toString('base64'))
  })
})
