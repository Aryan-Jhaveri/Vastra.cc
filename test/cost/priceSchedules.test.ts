import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../src/db/client.js'
import { aiCalls, users } from '../../src/db/schema.js'
import {
  computeWholesaleCostDetailed,
  getPriceSchedule,
  PRICE_SCHEDULES,
  priceScheduleAt,
  PROVIDER_REPORTED_COST,
  type PriceSchedule,
} from '../../src/cost/tokenTable.js'
import { runInstrumented, runInstrumentedDecisions } from '../../src/ai/instrumented.js'

// #344 — every cost estimate names the immutable price schedule behind it.

// A shipped schedule never changes. New or corrected rates → append a new
// schedule (and its hash here); never edit a hash to make this pass.
const SHIPPED: Record<string, string> = {
  'ps-2026-06-30': '59ada5dfcea998b7430f4deccaa9d8cd7d9cdf4bc236e57f9ad1af549717c3fe',
}

const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
      : v
const contentHash = (s: PriceSchedule) => createHash('sha256').update(JSON.stringify(stable(s))).digest('hex')

describe('PRICE_SCHEDULES', () => {
  it('shipped schedules are unchanged', () => {
    for (const [id, hash] of Object.entries(SHIPPED)) {
      const schedule = getPriceSchedule(id)
      expect(schedule, `${id} was removed`).toBeDefined()
      expect(contentHash(schedule!), `${id} was edited — add a new schedule instead`).toBe(hash)
    }
    expect(PRICE_SCHEDULES.map(s => s.id).filter(id => !(id in SHIPPED)), 'pin every new schedule in SHIPPED').toEqual([])
  })

  it('have unique ids, ascending effective dates and a source', () => {
    const ids = PRICE_SCHEDULES.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const dates = PRICE_SCHEDULES.map(s => s.effectiveFrom)
    expect([...dates].sort()).toEqual(dates)
    for (const s of PRICE_SCHEDULES) {
      expect(s.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.source.length).toBeGreaterThan(0)
    }
  })

  it('are frozen at runtime', () => {
    const [first] = PRICE_SCHEDULES
    const row = first.prices['gemini:gemini-2.5-flash'] as { inputPerMTokensX100: number }
    expect(() => { row.inputPerMTokensX100 = 1 }).toThrow()
    expect(() => { (PRICE_SCHEDULES as PriceSchedule[]).push(first) }).toThrow()
  })
})

describe('schedule selection and cost', () => {
  const base = PRICE_SCHEDULES[0]
  const raised: PriceSchedule = {
    ...base,
    id: 'ps-test-raise',
    effectiveFrom: '2030-01-01',
    source: 'test',
    prices: { ...base.prices, 'gemini:gemini-2.5-flash': { inputPerMTokensX100: 60000, outputPerMTokensX100: 500000 } },
  }
  const schedules = [base, raised]

  it('picks the latest schedule already in effect', () => {
    expect(priceScheduleAt(Date.UTC(2029, 11, 31, 23), schedules).id).toBe(base.id)
    expect(priceScheduleAt(Date.UTC(2030, 0, 1), schedules).id).toBe('ps-test-raise')
    // Before the first schedule: the first one (nothing older exists).
    expect(priceScheduleAt(Date.UTC(2020, 0, 1), schedules).id).toBe(base.id)
  })

  it('an estimate carries the schedule it came from, and a new schedule never changes an old estimate', () => {
    const usage = { tokensIn: 1_000_000, tokensOut: 100_000 }
    const before = computeWholesaleCostDetailed('gemini', 'gemini-2.5-flash', usage, base)
    const after = computeWholesaleCostDetailed('gemini', 'gemini-2.5-flash', usage, raised)
    expect(before).toEqual({ cost: 55000, known: true, priceScheduleId: base.id })
    expect(after).toEqual({ cost: 110000, known: true, priceScheduleId: 'ps-test-raise' })
    // The old schedule still prices exactly as it did.
    expect(computeWholesaleCostDetailed('gemini', 'gemini-2.5-flash', usage, base)).toEqual(before)
  })

  it('unknown and free costs still name the schedule that decided them', () => {
    expect(computeWholesaleCostDetailed('gemini', 'gemini-9-ultra', { tokensIn: 1, tokensOut: 1 }, base))
      .toEqual({ cost: 0, known: false, priceScheduleId: base.id })
    expect(computeWholesaleCostDetailed('self', 'local/qwen3-8b', { tokensIn: 1, tokensOut: 1 }, base))
      .toEqual({ cost: 0, known: true, priceScheduleId: base.id })
  })
})

describe('ai_calls.price_schedule_id', () => {
  const created: string[] = []
  function user(): string {
    const id = `u_${nanoid(8)}`
    db.insert(users).values({ id, email: `${id}@test.local`, createdAt: Date.now() }).run()
    created.push(id)
    return id
  }
  const rows = (userId: string) => db.select().from(aiCalls).where(eq(aiCalls.userId, userId)).all()

  afterEach(() => {
    for (const id of created.splice(0)) db.delete(users).where(eq(users.id, id)).run()
  })

  it('records the current schedule on a successful call', async () => {
    const u = user()
    await runInstrumented({
      userId: u, task: 'categorize', provider: 'gemini', model: 'gemini-2.5-flash', expectedBilledTokens: 0,
      call: async () => ({ result: 'ok', usage: { tokensIn: 1000, tokensOut: 100 } }),
    })
    expect(rows(u)).toEqual([expect.objectContaining({ priceScheduleId: priceScheduleAt().id, costKnown: 1, wholesaleCostCentsX100: 55 })])
  })

  it('a failure with usage is priced under the schedule; one without usage names none', async () => {
    const u = user()
    await expect(runInstrumented({
      userId: u, task: 'categorize', provider: 'gemini', model: 'gemini-2.5-flash', expectedBilledTokens: 0,
      call: async ({ reportUsage }) => { reportUsage({ tokensIn: 1000, tokensOut: 0 }); throw new Error('parse failed') },
    })).rejects.toThrow('parse failed')
    await expect(runInstrumented({
      userId: u, task: 'categorize', provider: 'gemini', model: 'gemini-2.5-flash', expectedBilledTokens: 0,
      call: async () => { throw new Error('network') },
    })).rejects.toThrow('network')
    const byError = Object.fromEntries(rows(u).map(r => [r.errorMessage, r.priceScheduleId]))
    expect(byError).toEqual({ 'parse failed': priceScheduleAt().id, network: null })
  })

  it('decision calls record where their cost came from', async () => {
    const u = user()
    const decision = (cost: number | null, priceScheduleId?: string) => async () => ({
      answers: {}, usage: { cost, inputTokens: 10, outputTokens: 0 }, model: null, id: null,
      ...(priceScheduleId ? { priceScheduleId } : {}),
    })
    await runInstrumentedDecisions({ userId: u, task: 'related', call: decision(0.0002, PROVIDER_REPORTED_COST) })
    await runInstrumentedDecisions({ userId: u, task: 'related', call: decision(null) })
    expect(rows(u).map(r => r.priceScheduleId).sort()).toEqual([null, PROVIDER_REPORTED_COST].sort())
  })
})
