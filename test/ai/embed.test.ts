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

const { mockEmbedContent, mockGoogleGenAI } = vi.hoisted(() => {
  const mockEmbedContent = vi.fn().mockResolvedValue({
    embeddings: [{ values: new Array(1024).fill(0.1) }],
  })
  const mockGoogleGenAI = vi.fn().mockImplementation(function () {
    this.models = { embedContent: mockEmbedContent }
  })
  return { mockEmbedContent, mockGoogleGenAI }
})

vi.mock('@google/genai', () => ({
  GoogleGenAI: mockGoogleGenAI,
}))

import {
  textItemSourceBlob,
  textOutfitSourceBlob,
  embedItemTextOnSave,
  embedOutfitTextOnSave,
  embedShareTextOnSave,
  embedText,
} from '../../src/ai/embed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(embeddings).run()
})

describe('textItemSourceBlob', () => {
  it('concatenates all item fields with pipe separators', () => {
    const blob = textItemSourceBlob({
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
})

describe('textOutfitSourceBlob', () => {
  it('concatenates outfit metadata fields', () => {
    const blob = textOutfitSourceBlob({
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

describe('embedItemTextOnSave', () => {
  it('skips when TEXT_EMBED_ENABLED is not set', async () => {
    delete process.env.TEXT_EMBED_ENABLED
    await expect(embedItemTextOnSave({
      id: 'test-skip',
      category: 'tops',
    })).resolves.toBeUndefined()
  })

  it('fails gracefully when API key is missing (flag enabled)', async () => {
    process.env.TEXT_EMBED_ENABLED = 'true'
    process.env.GEMINI_API_KEY = 'fake-key'

    await expect(embedItemTextOnSave({
      id: 'test-graceful',
      category: 'tops',
    })).resolves.toBeUndefined()

    delete process.env.TEXT_EMBED_ENABLED
    delete process.env.GEMINI_API_KEY
  })
})

describe('embedOutfitTextOnSave', () => {
  it('skips when flag disabled', async () => {
    delete process.env.TEXT_EMBED_ENABLED
    await expect(embedOutfitTextOnSave({
      id: 'test-outfit',
      name: 'Test',
    })).resolves.toBeUndefined()
  })
})

describe('embedShareTextOnSave', () => {
  it('skips when flag disabled', async () => {
    delete process.env.TEXT_EMBED_ENABLED
    await expect(embedShareTextOnSave({
      id: 'test-share',
      description: 'test',
    })).resolves.toBeUndefined()
  })
})

// ─── Vertex routing ───────────────────────────────────────────────────────────

describe('vertex routing', () => {
  it('constructs GoogleGenAI with vertexai: true + project + location', () => {
    expect(mockGoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({ vertexai: true, project: 'test-project', location: 'us-west1' }),
    )
  })

  it('embedText returns vector of TEXT_EMBED_DIM length', async () => {
    const dim = 1024
    mockEmbedContent.mockResolvedValueOnce({
      embeddings: [{ values: new Array(dim).fill(0.1) }],
    })

    const vec = await embedText('test clothing item')

    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec.length).toBe(dim)
  })
})
