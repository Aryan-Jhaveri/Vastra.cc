import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'

// find_related, discover_closet, list_my_photos and try_on against the real DB,
// wallet and runInstrumented. Only the model edges are stubbed: the decision
// client (Jev), try-on image generation, wear suggestions and image reads.

const { decide } = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('../../src/ai/decisions.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/ai/decisions.js')>(),
  generateDecisions: decide,
}))
vi.mock('../../src/ai/tryon.js', () => ({
  generateTryOn: vi.fn(async () => 'images/users/x/tryon/result.jpg'),
  generateWearSuggestions: vi.fn(async () => ({ data: [{ label: 'Rolled', instruction: 'Roll the sleeves', itemIndex: 0 }], usage: { tokensIn: 1, tokensOut: 1 } })),
}))
vi.mock('../../src/storage/images.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/storage/images.js')>(),
  imageToBase64SquarePadded: vi.fn(async () => 'photo-b64'),
  imageToBase64Compressed: vi.fn(async () => 'item-b64'),
}))

import { db } from '../../src/db/client.js'
import {
  aiCalls, embeddings, items, outfits, queryEmbeddings, relatedRequests, tryonResults, userPhotos, userWallets, users,
} from '../../src/db/schema.js'
import { executeTool, getTool, isToolAvailable, needsConfirmation, prepareWrite, type AgentContext } from '../../src/agent/tools.js'
import { generateTryOn } from '../../src/ai/tryon.js'
import { mockEmbeddingVector, saveEmbedding, TEXT_EMBED_DIM, TEXT_EMBED_MODEL_VERSION } from '../../src/storage/embeddings.js'
import { tokenCost } from '../../src/cost/tokenTable.js'

const A = 'agent-rdt-a'
const B = 'agent-rdt-b'
const ctx = (userId = A): AgentContext => ({ userId, identity: { runId: 'thread_1', turnId: 'turn_1', stepId: '0', toolCallId: 'call_1' } })
let seq = 0

function item(userId: string, category: string, extra: Partial<typeof items.$inferInsert> = {}) {
  const id = `rdt_i${++seq}`
  const now = Date.now() + seq
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category, createdAt: now, updatedAt: now, ...extra }).run()
  return id
}
function outfit(userId: string, itemIds: string[], name = `Outfit ${seq}`) {
  const id = `rdt_o${++seq}`
  db.insert(outfits).values({ id, userId, name, itemIds: JSON.stringify(itemIds), createdAt: Date.now() + seq }).run()
  return id
}
function photo(userId: string, extra: Partial<typeof userPhotos.$inferInsert> = {}) {
  const id = `rdt_p${++seq}`
  db.insert(userPhotos).values({ id, userId, imageUri: `images/user/${id}.jpg`, createdAt: Date.now() + seq, ...extra }).run()
  return id
}
function setBalance(userId: string, balance: number) {
  db.insert(userWallets).values({ userId, balanceTokens: balance, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: userWallets.userId, set: { balanceTokens: balance } }).run()
}
const balanceOf = (userId: string) => db.select().from(userWallets).where(eq(userWallets.userId, userId)).get()!.balanceTokens
function answerAll(noul = 0.8) {
  decide.mockImplementation(async (_s: unknown, qs: Record<string, unknown>) => ({
    answers: Object.fromEntries(Object.keys(qs).map(k => [k, { type: 'noul', noul }])),
    usage: { cost: 0.0001, inputTokens: 5, outputTokens: 1 }, model: 't', id: null,
  }))
}
async function vector(userId: string, level: 'item' | 'outfit', refId: string, text: string) {
  await saveEmbedding({
    level, refId, userId, variant: level === 'item' ? 'main' : 'metadata',
    modelVersion: TEXT_EMBED_MODEL_VERSION, vector: mockEmbeddingVector(text, TEXT_EMBED_DIM), sourceBlob: text,
  })
}

beforeAll(() => {
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) db.insert(users).values({ id, email: `${id}@t.co`, createdAt: Date.now() }).run()
  }
})
beforeEach(() => {
  decide.mockReset()
  vi.mocked(generateTryOn).mockClear()
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-master')
  vi.stubEnv('DECISIONS_PROVIDER', '')
  vi.stubEnv('MOCK_EMBEDDINGS', 'true')
  vi.stubEnv('MOCK_AI_IMAGE_GEN', '')
  const both = [A, B]
  for (const t of [relatedRequests, aiCalls, tryonResults, userPhotos, embeddings, queryEmbeddings, outfits, items]) {
    db.delete(t).where(inArray(t.userId, both)).run()
  }
  process.env.HOSTED_MODE = 'true'
})
afterEach(() => {
  vi.unstubAllEnvs()
  process.env.HOSTED_MODE = 'true'
})

// ─── find_related ──────────────────────────────────────────────────────────────

describe('find_related', () => {
  it('returns scored related items for an item, via the shared find (logged, capped, free)', async () => {
    const anchor = item(A, 'tops')
    const pants = item(A, 'bottoms')
    setBalance(A, 3)
    answerAll(0.9)
    const result = await executeTool('find_related', { kind: 'item', id: anchor }, ctx()) as any
    expect(result).toMatchObject({ kind: 'item', status: 'success' })
    expect(result.items.map((i: { id: string; score: number }) => [i.id, i.score])).toEqual([[pants, 0.9]])
    expect(JSON.stringify(result)).not.toContain(A) // no userId in the projection
    const [row] = db.select().from(relatedRequests).where(eq(relatedRequests.userId, A)).all()
    expect(row).toMatchObject({ status: 'success', countsTowardCap: 1 })
    // Jev decision rows: run_id = the find's request id, the tool call's identity, never billed.
    const calls = db.select().from(aiCalls).where(eq(aiCalls.userId, A)).all()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ task: 'related', runId: row.id, turnId: 'turn_1', toolCallId: 'call_1', billedTokens: 0 })
    expect(balanceOf(A)).toBe(3)
  })

  it('reuses a still-valid saved result without a model call or a quota slot', async () => {
    const anchor = item(A, 'tops')
    item(A, 'shoes')
    answerAll(0.7)
    await executeTool('find_related', { kind: 'item', id: anchor }, ctx())
    decide.mockClear()
    const again = await executeTool('find_related', { kind: 'item', id: anchor }, ctx()) as any
    expect(again).toMatchObject({ status: 'success', reused: true })
    expect(decide).not.toHaveBeenCalled()
    expect(db.select().from(relatedRequests).where(eq(relatedRequests.userId, A)).all()).toHaveLength(1)
  })

  it('returns related saved outfits for an outfit', async () => {
    const t = item(A, 'tops'); const b = item(A, 'bottoms')
    const anchor = outfit(A, [t, b], 'Office')
    const other = outfit(A, [t], 'Friday')
    answerAll(0.8)
    const result = await executeTool('find_related', { kind: 'outfit', id: anchor }, ctx()) as any
    expect(result.outfits.map((o: { id: string }) => o.id)).toEqual([other])
    expect(result.outfits[0].items[0]).toMatchObject({ id: t })
  })

  it("another user's item / outfit / collection id is not found, with no model call and no log row", async () => {
    const theirs = item(B, 'tops')
    item(B, 'bottoms')
    const theirOutfit = outfit(B, [theirs])
    answerAll()
    await expect(executeTool('find_related', { kind: 'item', id: theirs }, ctx())).rejects.toThrow(`Item ${theirs} not found`)
    await expect(executeTool('find_related', { kind: 'outfit', id: theirOutfit }, ctx())).rejects.toThrow('not found')
    await expect(executeTool('find_related', { kind: 'collection', id: 'col_x' }, ctx())).rejects.toThrow('not found')
    expect(decide).not.toHaveBeenCalled()
    expect(db.select().from(relatedRequests).where(inArray(relatedRequests.userId, [A, B])).all()).toHaveLength(0)
  })

  it('without a decision provider, falls back to word matching over the same user-scoped candidates', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(isToolAvailable(getTool('find_related')!)).toBe(true)
    const anchor = item(A, 'tops', { colors: '["navy"]', season: '["winter"]', tags: '["office"]' })
    const match = item(A, 'bottoms', { colors: '["navy"]', tags: '["office"]' })
    item(A, 'shoes', { colors: '["pink"]', season: '["summer"]' })
    item(A, 'tops', { colors: '["navy"]', tags: '["office"]' }) // same category: never a pair
    item(B, 'bottoms', { colors: '["navy"]', season: '["winter"]', tags: '["office"]' }) // other user
    const result = await executeTool('find_related', { kind: 'item', id: anchor }, ctx()) as any
    expect(result).toMatchObject({ kind: 'item', status: 'success', method: 'keyword' })
    expect(result.items.map((i: { id: string }) => i.id)).toEqual([match])
    expect(result.items[0].score).toBeCloseTo(2 / 3)
    expect(decide).not.toHaveBeenCalled()
    expect(db.select().from(relatedRequests).where(eq(relatedRequests.userId, A)).all()).toHaveLength(0)
    expect(db.select().from(aiCalls).where(eq(aiCalls.userId, A)).all()).toHaveLength(0)
    const { runRelatedFind } = await import('../../src/ai/related.js')
    await expect(runRelatedFind('item', 'x', A)).resolves.toEqual({ status: 'unavailable' })
  })

  it('keyword fallback: outfits sharing words rank first; empty when nothing overlaps; foreign ids not found', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const t = item(A, 'tops', { colors: '["navy"]' }); const b = item(A, 'bottoms', { colors: '["grey"]' })
    const s = item(A, 'shoes', { colors: '["pink"]' })
    const anchor = outfit(A, [t, b], 'Office')
    const close = outfit(A, [t], 'Office Friday')
    const far = outfit(A, [s], 'Beach')
    const result = await executeTool('find_related', { kind: 'outfit', id: anchor }, ctx()) as any
    expect(result.method).toBe('keyword')
    expect(result.outfits[0].id).toBe(close)
    expect(result.outfits.map((o: { id: string }) => o.id)).not.toContain(anchor)
    if (result.outfits.length > 1) expect(result.outfits.map((o: { id: string }) => o.id).indexOf(far)).toBeGreaterThan(0)
    const lone = item(A, 'tops')
    await expect(executeTool('find_related', { kind: 'item', id: lone }, ctx())).resolves.toMatchObject({ status: 'empty', method: 'keyword' })
    const theirs = item(B, 'tops', { colors: '["navy"]' })
    await expect(executeTool('find_related', { kind: 'item', id: theirs }, ctx())).rejects.toThrow('not found')
  })
})

// ─── discover_closet ───────────────────────────────────────────────────────────

describe('discover_closet', () => {
  it('returns embedding matches and related saved outfits, with no LLM call and no ai_calls row', async () => {
    const yellow = item(A, 'tops', { primaryColor: 'yellow' })
    const blue = item(A, 'bottoms', { primaryColor: 'blue' })
    await vector(A, 'item', yellow, 'all yellow')
    await vector(A, 'item', blue, 'navy trousers')
    const sunny = outfit(A, [yellow, blue], 'Sunny')
    await vector(A, 'outfit', sunny, 'all yellow')
    setBalance(A, 5)

    const result = await executeTool('discover_closet', { query: 'all yellow' }, ctx()) as any

    expect(result.itemSource).toBe('embedding')
    expect(result.items[0].id).toBe(yellow)
    expect(result.outfits.map((o: { id: string }) => o.id)).toEqual([sunny])
    expect(result.outfitSource).toBe('fused')
    expect(decide).not.toHaveBeenCalled()
    expect(db.select().from(aiCalls).where(eq(aiCalls.userId, A)).all()).toHaveLength(0)
    expect(balanceOf(A)).toBe(5)
  })

  it('falls back to keyword search when the closet has no vectors', async () => {
    const linen = item(A, 'tops', { material: 'linen', aiDescription: 'white linen shirt' })
    item(A, 'shoes', { aiDescription: 'black boots' })
    const result = await executeTool('discover_closet', { query: 'linen shirt' }, ctx()) as any
    expect(result.itemSource).toBe('keyword')
    expect(result.items.map((i: { id: string }) => i.id)).toEqual([linen])
  })

  it("never returns another user's items or outfits, even with identical vectors", async () => {
    const mine = item(A, 'tops')
    const theirs = item(B, 'tops')
    await vector(A, 'item', mine, 'red dress')
    await vector(B, 'item', theirs, 'red dress')
    const theirOutfit = outfit(B, [theirs])
    await vector(B, 'outfit', theirOutfit, 'red dress')

    const result = await executeTool('discover_closet', { query: 'red dress' }, ctx()) as any
    const ids = JSON.stringify(result)
    expect(result.items.map((i: { id: string }) => i.id)).toEqual([mine])
    expect(ids).not.toContain(theirs)
    expect(ids).not.toContain(theirOutfit)
  })
})

// ─── list_my_photos ────────────────────────────────────────────────────────────

describe('list_my_photos', () => {
  it('lists only the caller\'s photos', async () => {
    const mine = photo(A, { label: 'Mirror', isPrimary: 1 })
    photo(B)
    const result = await executeTool('list_my_photos', {}, ctx()) as any
    expect(result.photos).toEqual([expect.objectContaining({ id: mine, label: 'Mirror', isPrimary: true })])
    expect(JSON.stringify(result)).not.toContain(A)
  })

  it('tells the user to add one in the app when there are none', async () => {
    photo(B)
    const result = await executeTool('list_my_photos', {}, ctx()) as any
    expect(result.photos).toEqual([])
    expect(result.message).toMatch(/Add one in the app/)
    expect(result.addAt).toBe('/tryon')
  })
})

// ─── try_on ────────────────────────────────────────────────────────────────────

describe('try_on', () => {
  it('is an ai-scope tool that needs confirmation', () => {
    const tool = getTool('try_on')!
    expect(tool.scope).toBe('ai')
    expect(needsConfirmation(tool)).toBe(true)
    expect(needsConfirmation(getTool('suggest_outfit'))).toBe(false)
  })

  it('self-host: runs without touching the wallet', async () => {
    delete process.env.HOSTED_MODE
    try {
      photo(A)
      const t = item(A, 'tops')
      setBalance(A, 0)
      const result = await executeTool('try_on', { item_ids: [t] }, ctx()) as any
      expect(result.tokensCharged).toBe(0)
      expect(balanceOf(A)).toBe(0)
      expect(db.select().from(tryonResults).where(eq(tryonResults.userId, A)).all()).toHaveLength(1)
    } finally {
      process.env.HOSTED_MODE = 'true'
    }
  })

  it('mock image gen is free even when hosted', async () => {
    vi.stubEnv('MOCK_AI_IMAGE_GEN', 'true')
    photo(A)
    const t = item(A, 'tops')
    setBalance(A, 0)
    const check = await prepareWrite('try_on', { item_ids: [t] }, ctx())
    expect(check).toEqual({ ok: true, summary: 'Try on 1 item on your photo' })
    const result = await executeTool('try_on', { item_ids: [t] }, ctx()) as any
    expect(result.tokensCharged).toBe(0)
    expect(balanceOf(A)).toBe(0)
  })

  it('tries on a saved outfit and links the history row to it', async () => {
    photo(A, { isPrimary: 1 })
    const t = item(A, 'tops'); const b = item(A, 'bottoms')
    const o = outfit(A, [t, b, 'deleted_item'], 'Weekend')
    setBalance(A, 40)
    const check = await prepareWrite('try_on', { outfit_id: o }, ctx())
    expect(check).toEqual({ ok: true, summary: `Try on “Weekend” on your primary photo (costs ${tokenCost('tryon')} tokens)` })
    const result = await executeTool('try_on', { outfit_id: o }, ctx()) as any
    expect(result).toMatchObject({ outfitId: o, outfitName: 'Weekend', itemIds: [t, b] })
    expect(db.select().from(tryonResults).where(eq(tryonResults.id, result.tryonId)).get()!.outfitId).toBe(o)
  })

  it('with no photos, says to add one in the app', async () => {
    const t = item(A, 'tops')
    const check = await prepareWrite('try_on', { item_ids: [t] }, ctx())
    expect(check).toMatchObject({ ok: false, error: expect.stringMatching(/Add one in the app/) })
  })

  it('rejects both or neither of item_ids / outfit_id', async () => {
    photo(A)
    expect((await prepareWrite('try_on', {}, ctx())).ok).toBe(false)
    expect((await prepareWrite('try_on', { item_ids: ['a'], outfit_id: 'b' }, ctx())).ok).toBe(false)
  })

  it("another user's photo, item or outfit is not found; nothing is generated or charged", async () => {
    const myPhoto = photo(A)
    const myItem = item(A, 'tops')
    const theirPhoto = photo(B)
    const theirItem = item(B, 'tops')
    const theirOutfit = outfit(B, [theirItem])
    setBalance(A, 40)
    await expect(executeTool('try_on', { photo_id: theirPhoto, item_ids: [myItem] }, ctx())).rejects.toThrow(`Photo ${theirPhoto} not found`)
    await expect(executeTool('try_on', { photo_id: myPhoto, item_ids: [theirItem] }, ctx())).rejects.toThrow(`Item ${theirItem} not found`)
    await expect(executeTool('try_on', { photo_id: myPhoto, outfit_id: theirOutfit }, ctx())).rejects.toThrow(`Outfit ${theirOutfit} not found`)
    expect(generateTryOn).not.toHaveBeenCalled()
    expect(balanceOf(A)).toBe(40)
    expect(db.select().from(tryonResults).where(inArray(tryonResults.userId, [A, B])).all()).toHaveLength(0)
  })
})
