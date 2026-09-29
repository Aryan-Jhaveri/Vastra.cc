import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { join } from 'path'

// Storage stays REAL: the bug under test is the interaction between the
// route and deleteImage/resolveImagePath against the on-disk tree.
vi.mock('../../../../src/tools/outfits.js', () => ({
  createOutfit: vi.fn(),
  listOutfits: vi.fn(),
  updateOutfit: vi.fn(),
  deleteOutfit: vi.fn(),
  markOutfitWorn: vi.fn(),
  OutfitItemOwnershipError: class OutfitItemOwnershipError extends Error {},
}))

vi.mock('../../../../src/tools/items.js', () => ({
  listItems: vi.fn(),
}))

vi.mock('../../../../src/db/queries.js', () => ({
  getOutfit: vi.fn(),
  updateOutfit: vi.fn(),
}))

vi.mock('../../../../src/ai/instrumented.js', () => ({
  runEmbeddingInstrumented: vi.fn(),
}))

vi.mock('../../../../src/ai/embedImage.js', () => ({
  embedOutfitCoverOnSave: vi.fn(),
  embedOutfitCentroidOnSave: vi.fn(),
  deleteEmbeddingsForOutfit: vi.fn(),
}))

vi.mock('../../../../src/ai/embed.js', () => ({
  embedOutfitTextOnSave: vi.fn(),
  deleteTextEmbeddingsForOutfit: vi.fn(),
  textOutfitSourceBlob: vi.fn(() => ''),
}))

import * as queries from '../../../../src/db/queries.js'
import outfitsRouter from '../../../../src/transport/web/routes/outfits.js'

const DATA_DIR = process.env.CLOSET_DATA_DIR!

function makeApp(userId: string) {
  const app = express()
  app.use((req, _res, next) => { req.userId = userId; next() })
  app.use('/', outfitsRouter)
  return app
}

let seq = 0
function freshOutfit(userId: string, coverImageUri: string | null) {
  seq++
  return {
    id: `outfit-${seq}`,
    userId,
    name: `Outfit ${seq}`,
    itemIds: '[]',
    occasion: null,
    season: '[]',
    aiGenerated: 0,
    weatherContext: null,
    notes: null,
    coverImageUri,
    tags: '[]',
    timesWorn: 0,
    lastWornAt: null,
    createdAt: Date.now(),
  }
}

function userOutfitFile(userId: string, name: string): string {
  return join(DATA_DIR, 'users', userId, 'images', 'outfits', name)
}

function plantUserOutfitFile(userId: string, name: string): void {
  mkdirSync(join(DATA_DIR, 'users', userId, 'images', 'outfits'), { recursive: true })
  writeFileSync(userOutfitFile(userId, name), 'x')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DELETE /:id/cover', () => {
  it('removes a cover whose file is already gone and nulls the column', async () => {
    const outfit = freshOutfit('u1', 'images/outfits/gone.jpg')
    vi.mocked(queries.getOutfit).mockReturnValue(outfit as any)
    vi.mocked(queries.updateOutfit).mockReturnValue({ ...outfit, coverImageUri: null } as any)

    const res = await request(makeApp('u1')).delete(`/${outfit.id}/cover`)
    expect(res.status).toBe(200)
    expect(res.body.coverImageUri).toBeNull()
    expect(queries.updateOutfit).toHaveBeenCalledWith(outfit.id, 'u1', { coverImageUri: null })
  })

  it('removes a cover whose stored path is refused, without touching the foreign file', async () => {
    // A URI that escapes users/<userId>/images/ — resolveImagePath throws
    // "Refusing image path outside user storage" instead of unlinking.
    const foreignRel = 'images/../../victim/images/outfits/secret.jpg'
    const foreignAbs = join(DATA_DIR, 'victim', 'images', 'outfits', 'secret.jpg')
    mkdirSync(join(DATA_DIR, 'victim/images/outfits'), { recursive: true })
    writeFileSync(foreignAbs, 'x')

    const outfit = freshOutfit('u1', foreignRel)
    vi.mocked(queries.getOutfit).mockReturnValue(outfit as any)
    vi.mocked(queries.updateOutfit).mockReturnValue({ ...outfit, coverImageUri: null } as any)

    const res = await request(makeApp('u1')).delete(`/${outfit.id}/cover`)
    expect(res.status).toBe(200)
    expect(res.body.coverImageUri).toBeNull()
    expect(queries.updateOutfit).toHaveBeenCalledWith(outfit.id, 'u1', { coverImageUri: null })
    expect(existsSync(foreignAbs)).toBe(true)

    rmSync(join(DATA_DIR, 'victim'), { recursive: true, force: true })
  })

  it('deletes the existing cover file and its thumb from the owner tree', async () => {
    plantUserOutfitFile('u1', 'real.jpg')
    plantUserOutfitFile('u1', 'real_thumb.jpg')
    const outfit = freshOutfit('u1', 'images/outfits/real.jpg')
    vi.mocked(queries.getOutfit).mockReturnValue(outfit as any)
    vi.mocked(queries.updateOutfit).mockReturnValue({ ...outfit, coverImageUri: null } as any)

    const res = await request(makeApp('u1')).delete(`/${outfit.id}/cover`)
    expect(res.status).toBe(200)
    expect(existsSync(userOutfitFile('u1', 'real.jpg'))).toBe(false)
    expect(existsSync(userOutfitFile('u1', 'real_thumb.jpg'))).toBe(false)
  })

  it('still nulls the column when the unlink itself fails', async () => {
    // Plant the cover in its own user tree (tests in this file run
    // concurrently), then make the outfits dir read-only so unlink gets
    // EACCES — removal must succeed anyway; cleanup is best-effort.
    const userId = 'unlink-denied'
    plantUserOutfitFile(userId, 'stuck.jpg')
    const outfitDir = join(DATA_DIR, 'users', userId, 'images', 'outfits')
    const outfit = freshOutfit(userId, 'images/outfits/stuck.jpg')
    vi.mocked(queries.getOutfit).mockReturnValue(outfit as any)
    vi.mocked(queries.updateOutfit).mockReturnValue({ ...outfit, coverImageUri: null } as any)

    chmodSync(outfitDir, 0o555)
    try {
      const res = await request(makeApp(userId)).delete(`/${outfit.id}/cover`)
      expect(res.status).toBe(200)
      expect(res.body.coverImageUri).toBeNull()
      expect(existsSync(userOutfitFile(userId, 'stuck.jpg'))).toBe(true)
    } finally {
      chmodSync(outfitDir, 0o755)
    }
  })

  it('lets user B not remove user A\'s cover', async () => {
    plantUserOutfitFile('alice', 'a.jpg')
    const aliceOutfit = freshOutfit('alice', 'images/outfits/a.jpg')
    vi.mocked(queries.getOutfit).mockImplementation(((id: string, userId: string) =>
      id === aliceOutfit.id && userId === 'alice' ? aliceOutfit : undefined) as any)

    const res = await request(makeApp('bob')).delete(`/${aliceOutfit.id}/cover`)
    expect(res.status).toBe(404)
    expect(queries.updateOutfit).not.toHaveBeenCalled()
    expect(existsSync(userOutfitFile('alice', 'a.jpg'))).toBe(true)
  })

  it('returns 404 when the outfit vanishes between the check and the update', async () => {
    const outfit = freshOutfit('u1', 'images/outfits/gone.jpg')
    vi.mocked(queries.getOutfit).mockReturnValue(outfit as any)
    vi.mocked(queries.updateOutfit).mockReturnValue(undefined as any)

    const res = await request(makeApp('u1')).delete(`/${outfit.id}/cover`)
    expect(res.status).toBe(404)
  })

  it('returns 404 for a missing outfit and never touches storage', async () => {
    vi.mocked(queries.getOutfit).mockReturnValue(undefined as any)
    const res = await request(makeApp('u1')).delete('/ghost/cover')
    expect(res.status).toBe(404)
    expect(queries.updateOutfit).not.toHaveBeenCalled()
  })
})
