import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { and, eq, inArray } from 'drizzle-orm'

// #332 / #279 — "Find related" routes, request log and daily cap, against the
// real DB. The decision client is stubbed.
const { decide } = vi.hoisted(() => ({ decide: vi.fn() }))
vi.mock('../../../../src/ai/decisions.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/ai/decisions.js')>(),
  generateDecisions: decide,
}))

import { db } from '../../../../src/db/client.js'
import { aiCalls, items, relatedRequests, users } from '../../../../src/db/schema.js'
import { findRelated, lastRelatedResult, relatedQuotaHandler } from '../../../../src/transport/web/routes/related.js'
import { RELATED_WINDOW_MS } from '../../../../src/db/relatedRequests.js'

const A = 'relroute-a'
const B = 'relroute-b'
let seq = 0

function appAs(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.post('/items/:id/related', findRelated('item'))
  app.get('/items/:id/related', lastRelatedResult('item'))
  app.get('/related/quota', relatedQuotaHandler)
  return app
}
function item(userId: string, category: string) {
  const id = `ri_${++seq}`
  const now = Date.now() + seq
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category, createdAt: now, updatedAt: now }).run()
  return id
}
function answerAll(noul = 0.7, delayMs = 0) {
  decide.mockImplementation(async (_s: unknown, qs: Record<string, unknown>) => {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    return { answers: Object.fromEntries(Object.keys(qs).map(k => [k, { type: 'noul', noul }])), usage: { cost: 0.0002, inputTokens: 5, outputTokens: 1 }, model: 't', id: null }
  })
}
const rows = (userId = A) => db.select().from(relatedRequests).where(eq(relatedRequests.userId, userId)).all()

beforeAll(() => {
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) db.insert(users).values({ id, email: `${id}@t.co`, createdAt: Date.now() }).run()
  }
})
beforeEach(() => {
  decide.mockReset()
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-master')
  vi.stubEnv('DECISIONS_PROVIDER', '')
  db.delete(relatedRequests).where(inArray(relatedRequests.userId, [A, B])).run()
  db.delete(aiCalls).where(inArray(aiCalls.userId, [A, B])).run()
  db.delete(items).where(inArray(items.userId, [A, B])).run()
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /items/:id/related', () => {
  it('returns hydrated items with scores and logs one counted success row', async () => {
    const anchor = item(A, 'tops')
    const pants = item(A, 'bottoms')
    answerAll(0.9)
    const res = await request(appAs(A)).post(`/items/${anchor}/related`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ kind: 'item', status: 'success', scores: { [pants]: 0.9 }, quota: { used: 1, limit: 100 } })
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([pants])
    const [row] = rows()
    expect(row).toMatchObject({ kind: 'item', targetId: anchor, status: 'success', countsTowardCap: 1, candidateCount: 1, batchCount: 1 })
    expect(row.costX100).toBe(20) // $0.0002 from the batch's ai_calls row
    expect(db.select().from(aiCalls).where(eq(aiCalls.runId, row.id)).all()).toHaveLength(1)
  })

  it('404s for another user\'s item, with no model call and no log row', async () => {
    const theirs = item(B, 'tops')
    answerAll()
    const res = await request(appAs(A)).post(`/items/${theirs}/related`)
    expect(res.status).toBe(404)
    expect(decide).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0)
  })

  it('an item with nothing to pair with is an empty result that still counts', async () => {
    const anchor = item(A, 'tops')
    const res = await request(appAs(A)).post(`/items/${anchor}/related`)
    expect(res.body.status).toBe('empty')
    expect(decide).not.toHaveBeenCalled()
    expect(rows()[0]).toMatchObject({ status: 'empty', countsTowardCap: 1 })
  })

  it('a decision error is 502, logged as error, and does not use quota', async () => {
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    decide.mockRejectedValue(new Error('HTTP 503'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await request(appAs(A)).post(`/items/${anchor}/related`)
    expect(res.status).toBe(502)
    expect(res.body.quota.used).toBe(0)
    expect(rows()[0]).toMatchObject({ status: 'error', countsTowardCap: 0 })
  })

  it('caps at RELATED_DAILY_LIMIT over a rolling 24 h window, logging the capped attempt', async () => {
    vi.stubEnv('RELATED_DAILY_LIMIT', '2')
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    answerAll()
    expect((await request(appAs(A)).post(`/items/${anchor}/related`)).status).toBe(200)
    expect((await request(appAs(A)).post(`/items/${anchor}/related`)).status).toBe(200)
    const capped = await request(appAs(A)).post(`/items/${anchor}/related`)
    expect(capped.status).toBe(429)
    expect(capped.body.error).toBe('related_daily_limit')
    expect(capped.body.resetsAt).toBeGreaterThan(Date.now())
    expect(rows().filter(r => r.status === 'capped')).toHaveLength(1)

    // Finds older than 24 h age out of the window.
    db.update(relatedRequests).set({ createdAt: Date.now() - RELATED_WINDOW_MS - 1000 })
      .where(and(eq(relatedRequests.userId, A), eq(relatedRequests.status, 'success'))).run()
    expect((await request(appAs(A)).post(`/items/${anchor}/related`)).status).toBe(200)
  })

  it('race: 5 parallel taps with 1 find left → exactly 1 runs', async () => {
    vi.stubEnv('RELATED_DAILY_LIMIT', '1')
    const anchor = item(A, 'tops')
    item(A, 'bottoms')
    answerAll(0.5, 50)
    const app = appAs(A)
    const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/items/${anchor}/related`)))
    const statuses = results.map(r => r.status).sort()
    expect(statuses.filter(s => s === 200)).toHaveLength(1)
    expect(statuses.every(s => s === 200 || s === 409 || s === 429)).toBe(true)
    expect(rows().filter(r => r.countsTowardCap === 1)).toHaveLength(1)
  })

  it('503 when no decision provider is configured', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const anchor = item(A, 'tops')
    const res = await request(appAs(A)).post(`/items/${anchor}/related`)
    expect(res.status).toBe(503)
    expect(rows()).toHaveLength(0)
  })
})

describe('GET /items/:id/related (saved result)', () => {
  it('returns the last result without a model call or quota, until the anchor changes', async () => {
    const anchor = item(A, 'tops')
    const pants = item(A, 'bottoms')
    answerAll(0.8)
    await request(appAs(A)).post(`/items/${anchor}/related`)
    decide.mockClear()

    const saved = await request(appAs(A)).get(`/items/${anchor}/related`)
    expect(saved.body).toMatchObject({ found: true, status: 'success', scores: { [pants]: 0.8 } })
    expect(saved.body.foundAt).toBeLessThanOrEqual(Date.now())
    expect(decide).not.toHaveBeenCalled()
    expect((await request(appAs(A)).get('/related/quota')).body.used).toBe(1)

    db.update(items).set({ updatedAt: Date.now() + 60_000 }).where(eq(items.id, anchor)).run()
    expect((await request(appAs(A)).get(`/items/${anchor}/related`)).body).toEqual({ kind: 'item', found: false })
  })

  it('never shows another user\'s saved result', async () => {
    const theirs = item(B, 'tops')
    item(B, 'bottoms')
    answerAll()
    await request(appAs(B)).post(`/items/${theirs}/related`)
    expect((await request(appAs(A)).get(`/items/${theirs}/related`)).status).toBe(404)
  })
})
