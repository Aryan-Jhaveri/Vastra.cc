import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'

// #376 — the embeddings reconciler re-embeds items and outfits whose metadata
// changed after their text vector was written (e.g. deleting a tag
// everywhere), one user at a time, with a per-run cap on model calls.

const { embedTextSpy } = vi.hoisted(() => ({ embedTextSpy: vi.fn() }))

vi.mock('../../src/ai/embed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/embed.js')>()
  embedTextSpy.mockImplementation((text: string) => actual.embedText(text))
  return { ...actual, embedText: embedTextSpy }
})

import { db } from '../../src/db/client.js'
import { embeddings, items, outfits, users } from '../../src/db/schema.js'
import { insertOutfit, markItemWorn, markOutfitWorn, updateItem, updateOutfit } from '../../src/db/queries.js'
import { deleteFacetEverywhere } from '../../src/tools/tags.js'
import { textItemSourceBlob, textOutfitSourceBlob } from '../../src/ai/embed.js'
import {
  listStaleItemTextEmbeddings, listStaleOutfitTextEmbeddings, reembedStaleTextEmbeddings,
} from '../../src/ai/embedBackfill.js'
import { saveEmbedding, TEXT_EMBED_MODEL_VERSION } from '../../src/storage/embeddings.js'
import { embeddingsReconcilerJob } from '../../src/jobs/types/embeddingsReconciler.js'

const A = 'user_stale_a'
const B = 'user_stale_b'
const OLD = 1_000

const envBefore = { text: process.env.TEXT_EMBED_ENABLED, mock: process.env.MOCK_EMBEDDINGS }

beforeAll(() => {
  process.env.TEXT_EMBED_ENABLED = 'true'
  process.env.MOCK_EMBEDDINGS = 'true'
  for (const id of [A, B]) db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).onConflictDoNothing().run()
})

afterAll(() => {
  if (envBefore.text === undefined) delete process.env.TEXT_EMBED_ENABLED
  else process.env.TEXT_EMBED_ENABLED = envBefore.text
  if (envBefore.mock === undefined) delete process.env.MOCK_EMBEDDINGS
  else process.env.MOCK_EMBEDDINGS = envBefore.mock
})

beforeEach(() => {
  db.delete(embeddings).run()
  for (const t of [outfits, items] as const) db.delete(t).run()
  embedTextSpy.mockClear()
})

// A row and a current vector of its text, both stamped in the past.
async function seedItem(id: string, userId: string, tags: string[]) {
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops',
    tags: JSON.stringify(tags), occasion: '[]', createdAt: OLD, updatedAt: OLD,
  }).run()
  const row = db.select().from(items).where(eq(items.id, id)).get()!
  await saveEmbedding({ level: 'item', refId: id, userId, variant: 'main', modelVersion: TEXT_EMBED_MODEL_VERSION, vector: new Float32Array([1, 0]), sourceBlob: textItemSourceBlob(row) })
  db.update(embeddings).set({ createdAt: OLD }).where(eq(embeddings.refId, id)).run()
}

async function seedOutfit(id: string, userId: string, tags: string[]) {
  db.insert(outfits).values({ id, userId, name: id, itemIds: '[]', tags: JSON.stringify(tags), createdAt: OLD, updatedAt: OLD }).run()
  const row = db.select().from(outfits).where(eq(outfits.id, id)).get()!
  await saveEmbedding({ level: 'outfit', refId: id, userId, variant: 'metadata', modelVersion: TEXT_EMBED_MODEL_VERSION, vector: new Float32Array([1, 0]), sourceBlob: textOutfitSourceBlob(row) })
  db.update(embeddings).set({ createdAt: OLD }).where(eq(embeddings.refId, id)).run()
}

const vectorRow = (refId: string) => db.select().from(embeddings).where(eq(embeddings.refId, refId)).get()!
const embeddedTexts = () => embedTextSpy.mock.calls.map(c => c[0] as string)

describe('reembedStaleTextEmbeddings', () => {
  it('after a tag delete, re-embeds exactly the touched items and outfits of that user', async () => {
    await seedItem('ia1', A, ['festival', 'linen'])
    await seedItem('ia2', A, ['denim'])
    await seedItem('ib1', B, ['festival'])
    await seedOutfit('oa1', A, ['festival'])
    await seedOutfit('oa2', A, ['work'])
    await seedOutfit('ob1', B, ['festival'])

    expect(deleteFacetEverywhere(A, 'tag', ['festival'])).toEqual({ items: 1, outfits: 1, collections: 0 })
    // The delete bumps both change markers.
    expect(db.select().from(items).where(eq(items.id, 'ia1')).get()!.updatedAt).toBeGreaterThan(OLD)
    expect(db.select().from(outfits).where(eq(outfits.id, 'oa1')).get()!.updatedAt).toBeGreaterThan(OLD)

    const result = await reembedStaleTextEmbeddings('embed_reconcile')

    expect(result).toEqual({ items: 1, outfits: 1, unchanged: 0 })
    expect(embedTextSpy).toHaveBeenCalledTimes(2)
    expect(embeddedTexts().every(t => !t.includes('festival'))).toBe(true)
    expect(vectorRow('ia1').sourceBlob).not.toContain('festival')
    expect(vectorRow('ia1').sourceBlob).toContain('linen')
    expect(vectorRow('oa1').sourceBlob).not.toContain('festival')
    // Untouched rows, and user B (who still has the tag), keep their vectors.
    for (const id of ['ia2', 'oa2', 'ib1', 'ob1']) expect(vectorRow(id).createdAt).toBe(OLD)
    expect(vectorRow('ib1').sourceBlob).toContain('festival')
    expect(vectorRow('ob1').sourceBlob).toContain('festival')

    // Nothing left to do on the next run.
    embedTextSpy.mockClear()
    expect(await reembedStaleTextEmbeddings('embed_reconcile')).toEqual({ items: 0, outfits: 0, unchanged: 0 })
    expect(embedTextSpy).not.toHaveBeenCalled()
  })

  it('re-stamps a changed row whose text did not change, without a model call', async () => {
    await seedItem('ia1', A, ['linen'])
    await seedOutfit('oa1', A, ['work'])
    markItemWorn('ia1', A)
    updateOutfit('oa1', A, { coverImageUri: 'images/outfits/c.jpg' })

    expect(await reembedStaleTextEmbeddings('embed_reconcile')).toEqual({ items: 0, outfits: 0, unchanged: 2 })
    expect(embedTextSpy).not.toHaveBeenCalled()
    expect(listStaleItemTextEmbeddings(A)).toEqual([])
    expect(listStaleOutfitTextEmbeddings(A)).toEqual([])
  })

  it('skips rows a normal PATCH already re-embedded', async () => {
    await seedItem('ia1', A, ['linen'])
    const updated = updateItem('ia1', A, { tags: JSON.stringify(['wool']) })!
    // What the PATCH route does right after updateItem.
    await saveEmbedding({ level: 'item', refId: 'ia1', userId: A, variant: 'main', modelVersion: TEXT_EMBED_MODEL_VERSION, vector: new Float32Array([0, 1]), sourceBlob: textItemSourceBlob(updated) })

    expect(await reembedStaleTextEmbeddings('embed_reconcile')).toEqual({ items: 0, outfits: 0, unchanged: 0 })
    expect(embedTextSpy).not.toHaveBeenCalled()
  })

  it('leaves rows with no vector to the gap-filling backfill', async () => {
    db.insert(items).values({ id: 'ia1', userId: A, imageUri: 'images/items/ia1.jpg', category: 'tops', createdAt: OLD, updatedAt: Date.now() }).run()
    expect(await reembedStaleTextEmbeddings('embed_reconcile')).toEqual({ items: 0, outfits: 0, unchanged: 0 })
  })

  it('caps model calls per user, oldest change first, and finishes on later runs', async () => {
    for (let i = 0; i < 5; i++) await seedItem(`ia${i}`, A, ['festival', `t${i}`])
    deleteFacetEverywhere(A, 'tag', ['festival'])

    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 2 })).items).toBe(2)
    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 2 })).items).toBe(2)
    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 2 })).items).toBe(1)
    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 2 })).items).toBe(0)
    expect(embedTextSpy).toHaveBeenCalledTimes(5)
  })

  it('caps model calls per run across users', async () => {
    for (let i = 0; i < 3; i++) {
      await seedItem(`ia${i}`, A, ['festival', `t${i}`])
      await seedItem(`ib${i}`, B, ['festival', `t${i}`])
    }
    deleteFacetEverywhere(A, 'tag', ['festival'])
    deleteFacetEverywhere(B, 'tag', ['festival'])

    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 10, total: 4 })).items).toBe(4)
    expect(embedTextSpy).toHaveBeenCalledTimes(4)
    expect((await reembedStaleTextEmbeddings('embed_reconcile', { perUser: 10, total: 4 })).items).toBe(2)
  })

  it('does not save a vector for text that changed while it was being embedded', async () => {
    await seedItem('ia1', A, ['festival', 'linen'])
    deleteFacetEverywhere(A, 'tag', ['festival'])
    embedTextSpy.mockImplementationOnce(async () => {
      updateItem('ia1', A, { tags: JSON.stringify(['wool']) })
      return new Float32Array([0, 1])
    })

    expect((await reembedStaleTextEmbeddings('embed_reconcile')).items).toBe(0)
    // Old vector kept with its old stamp, so the row is still due.
    expect(vectorRow('ia1').createdAt).toBe(OLD)
    expect(listStaleItemTextEmbeddings(A).map(c => c.row.id)).toEqual(['ia1'])
  })

  it('does nothing while text embeddings are disabled', async () => {
    await seedItem('ia1', A, ['festival'])
    deleteFacetEverywhere(A, 'tag', ['festival'])
    process.env.TEXT_EMBED_ENABLED = 'false'
    try {
      expect(await reembedStaleTextEmbeddings('embed_reconcile')).toEqual({ items: 0, outfits: 0, unchanged: 0 })
    } finally {
      process.env.TEXT_EMBED_ENABLED = 'true'
    }
    expect(embedTextSpy).not.toHaveBeenCalled()
  })
})

describe('embeddings_reconciler job', () => {
  it('runs the stale pass after the gap fill and reports it', async () => {
    await seedItem('ia1', A, ['festival', 'linen'])
    await seedOutfit('oa1', A, ['festival'])
    deleteFacetEverywhere(A, 'tag', ['festival'])

    const { summary } = await embeddingsReconcilerJob.execute({}, { jobId: 'j1', userId: 'self' })

    expect(summary).toContain('stale: items=1 outfits=1 unchanged=0')
    expect(vectorRow('ia1').sourceBlob).not.toContain('festival')
  })
})

describe('stale candidate queries — per user', () => {
  it('return only the given user’s rows', async () => {
    await seedItem('ia1', A, ['festival'])
    await seedItem('ib1', B, ['festival'])
    await seedOutfit('oa1', A, ['festival'])
    await seedOutfit('ob1', B, ['festival'])
    deleteFacetEverywhere(A, 'tag', ['festival'])
    deleteFacetEverywhere(B, 'tag', ['festival'])

    expect(listStaleItemTextEmbeddings(A).map(c => c.row.id)).toEqual(['ia1'])
    expect(listStaleItemTextEmbeddings(B).map(c => c.row.id)).toEqual(['ib1'])
    expect(listStaleOutfitTextEmbeddings(A).map(c => c.row.id)).toEqual(['oa1'])
    expect(listStaleOutfitTextEmbeddings(B).map(c => c.row.id)).toEqual(['ob1'])
  })

  it('never pairs a row with a vector stored under another user', async () => {
    await seedItem('ia1', A, ['festival'])
    // Re-own A's vector row as B: A's item then has no vector of its own.
    db.update(embeddings).set({ userId: B }).where(and(eq(embeddings.refId, 'ia1'))).run()
    deleteFacetEverywhere(A, 'tag', ['festival'])

    expect(listStaleItemTextEmbeddings(A)).toEqual([])
    expect(listStaleItemTextEmbeddings(B)).toEqual([])
  })

  it('require a userId', () => {
    expect(() => listStaleItemTextEmbeddings('')).toThrow(/userId/)
    expect(() => listStaleOutfitTextEmbeddings(undefined as unknown as string)).toThrow(/userId/)
  })
})

describe('outfits.updated_at', () => {
  it('is set on insert, bumped by updateOutfit, and not by wearing', async () => {
    const o = insertOutfit({ userId: A, name: 'x', itemIds: '[]' })
    expect(o.updatedAt).toBeGreaterThan(0)
    db.update(outfits).set({ updatedAt: OLD }).where(eq(outfits.id, o.id)).run()

    markOutfitWorn(o.id, A)
    expect(db.select().from(outfits).where(eq(outfits.id, o.id)).get()!.updatedAt).toBe(OLD)

    expect(updateOutfit(o.id, A, { name: 'y' })!.updatedAt).toBeGreaterThan(OLD)
  })

  it('updateOutfit does not bump another user’s outfit', () => {
    const o = insertOutfit({ userId: A, name: 'x', itemIds: '[]' })
    db.update(outfits).set({ updatedAt: OLD }).where(inArray(outfits.id, [o.id])).run()
    expect(updateOutfit(o.id, B, { name: 'y' })).toBeUndefined()
    expect(db.select().from(outfits).where(eq(outfits.id, o.id)).get()!.updatedAt).toBe(OLD)
  })
})
