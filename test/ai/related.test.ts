import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'

// #332 / #279 — candidate plans and scoring for "Find related", against the
// real DB. The decision client is stubbed with deterministic Nouls.
const { decide } = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('../../src/ai/decisions.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/ai/decisions.js')>(),
  generateDecisions: decide,
}))

import { db } from '../../src/db/client.js'
import { aiCalls, collectionOutfits, collections, items, outfits, users } from '../../src/db/schema.js'
import {
  relatedPlan, RelatedNotFoundError, scoreRelated, RELATED_COLLECTION_THRESHOLD, RELATED_ITEM_TOP,
} from '../../src/ai/related.js'

const A = 'related-user-a'
const B = 'related-user-b'
let seq = 0

function item(userId: string, category: string, extra: Partial<typeof items.$inferInsert> = {}) {
  const id = `it_${userId.slice(-1)}_${++seq}`
  const now = Date.now() + seq
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category, createdAt: now, updatedAt: now, ...extra }).run()
  return id
}
function outfit(userId: string, itemIds: string[], name = `Outfit ${++seq}`) {
  const id = `of_${userId.slice(-1)}_${++seq}`
  db.insert(outfits).values({ id, userId, name, itemIds: JSON.stringify(itemIds), createdAt: Date.now() + seq }).run()
  return id
}

/** Noul = the number in the candidate's name/id order: deterministic scores. */
function scoreBy(fn: (candidateJson: string, key: string) => number) {
  decide.mockImplementation(async (_state: unknown, questions: Record<string, { instructions: string }>) => ({
    answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'noul', noul: fn(q.instructions, k) }])),
    usage: { cost: 0.0001, inputTokens: 10, outputTokens: 1 }, model: 'test', id: null,
  }))
}

beforeAll(() => {
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) db.insert(users).values({ id, email: `${id}@t.co`, createdAt: Date.now() }).run()
  }
})
beforeEach(() => {
  decide.mockReset()
  db.delete(collectionOutfits).run()
  db.delete(collections).where(inArray(collections.userId, [A, B])).run()
  db.delete(outfits).where(inArray(outfits.userId, [A, B])).run()
  db.delete(items).where(inArray(items.userId, [A, B])).run()
  db.delete(aiCalls).where(inArray(aiCalls.userId, [A, B])).run()
})
afterEach(() => vi.unstubAllEnvs())

describe('relatedPlan', () => {
  it('items: other categories only, never the anchor or another user\'s items', () => {
    const anchor = item(A, 'tops')
    const sameCat = item(A, 'tops')
    const pants = item(A, 'bottoms')
    const shoes = item(A, 'shoes')
    item(B, 'bottoms')
    const ids = relatedPlan('item', anchor, A).candidates.map(c => c.id)
    expect(ids.sort()).toEqual([pants, shoes].sort())
    expect(ids).not.toContain(sameCat)
  })

  it('404s (RelatedNotFoundError) for another user\'s item, outfit or collection', () => {
    const theirs = item(B, 'tops')
    const theirOutfit = outfit(B, [theirs])
    expect(() => relatedPlan('item', theirs, A)).toThrow(RelatedNotFoundError)
    expect(() => relatedPlan('outfit', theirOutfit, A)).toThrow(RelatedNotFoundError)
    expect(() => relatedPlan('collection', 'nope', A)).toThrow(RelatedNotFoundError)
  })

  it('collections: candidates exclude outfits already in the collection', () => {
    const shirt = item(A, 'tops')
    const inIt = outfit(A, [shirt])
    const notIn = outfit(A, [shirt])
    db.insert(collections).values({ id: 'col1', userId: A, name: 'Workwear', createdAt: 1, updatedAt: 1 }).run()
    db.insert(collectionOutfits).values({ collectionId: 'col1', outfitId: inIt, position: 0, addedAt: 1 }).run()
    expect(relatedPlan('collection', 'col1', A).candidates.map(c => c.id)).toEqual([notIn])
  })

  it('the fingerprint changes when the anchor changes', () => {
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    const before = relatedPlan('item', anchor, A).fingerprint
    db.update(items).set({ updatedAt: Date.now() + 999_999 }).where(eq(items.id, anchor)).run()
    expect(relatedPlan('item', anchor, A).fingerprint).not.toBe(before)
  })
})

describe('scoreRelated', () => {
  it('batches 70 candidates into 3 calls of at most 32 and records each with run_id', async () => {
    const anchor = item(A, 'tops')
    for (let i = 0; i < 70; i++) item(A, 'bottoms')
    scoreBy(() => 0.5)
    const plan = relatedPlan('item', anchor, A)
    const { batchCount } = await scoreRelated(plan, { userId: A, requestId: 'req-70' })
    expect(batchCount).toBe(3)
    expect(decide.mock.calls.map(c => Object.keys(c[1]).length)).toEqual([32, 32, 6])
    const rows = db.select().from(aiCalls).where(eq(aiCalls.runId, 'req-70')).all()
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.task === 'related' && r.billedTokens === 0 && r.userId === A)).toBe(true)
  })

  it('caps candidates at 96 and keeps the top 8 items, best first', async () => {
    const anchor = item(A, 'tops')
    for (let i = 0; i < 150; i++) item(A, 'shoes', { brand: `b${i}` })
    // Score = brand number / 1000, so the highest brand numbers win.
    scoreBy(json => Number(/"brand":"b(\d+)"/.exec(json)![1]) / 1000)
    const plan = relatedPlan('item', anchor, A)
    expect(plan.candidates).toHaveLength(96)
    const { hits } = await scoreRelated(plan, { userId: A, requestId: 'req-cap' })
    expect(hits).toHaveLength(RELATED_ITEM_TOP)
    expect(hits.map(h => h.score)).toEqual([...hits.map(h => h.score)].sort((x, y) => y - x))
  })

  it('collections keep only outfits at or above the 0.6 threshold', async () => {
    const shirt = item(A, 'tops')
    const good = outfit(A, [shirt], 'Office A')
    outfit(A, [shirt], 'Beach B')
    db.insert(collections).values({ id: 'col2', userId: A, name: 'Workwear', createdAt: 1, updatedAt: 1 }).run()
    scoreBy(json => (json.includes('Office') ? 0.8 : 0.3))
    const { hits } = await scoreRelated(relatedPlan('collection', 'col2', A), { userId: A, requestId: 'req-col' })
    expect(hits).toEqual([{ id: good, score: 0.8 }])
    expect(RELATED_COLLECTION_THRESHOLD).toBe(0.6)
  })

  it('never sends a user id in the decision state or questions', async () => {
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    scoreBy(() => 0.4)
    await scoreRelated(relatedPlan('item', anchor, A), { userId: A, requestId: 'req-pii' })
    expect(JSON.stringify(decide.mock.calls)).not.toContain(A)
  })

  it('throws when a batch fails, so the route can report an uncounted error', async () => {
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    decide.mockRejectedValue(Object.assign(new Error('HTTP 503'), { status: 503 }))
    await expect(scoreRelated(relatedPlan('item', anchor, A), { userId: A, requestId: 'req-err' })).rejects.toThrow('HTTP 503')
  })
})
