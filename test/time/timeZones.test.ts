import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../src/db/client.js'
import { aiCalls, users } from '../../src/db/schema.js'
import { startOfNextUtcMonthMs, startOfUtcDayMs, startOfUtcMonthMs } from '../../src/time/utcDay.js'
import { localTime, normalizeTimeZone } from '../../src/time/zone.js'

// #213 — allowance windows reset at UTC midnight; chat time of day follows the
// user's zone, not the server's clock.

const MIDNIGHT = Date.UTC(2026, 8, 28) // 2026-09-28T00:00:00.000Z
const JUST_BEFORE = MIDNIGHT - 1        // 2026-09-27T23:59:59.999Z

describe('UTC allowance windows', () => {
  it('day and month boundaries are UTC, whatever the server zone', () => {
    expect(startOfUtcDayMs(JUST_BEFORE)).toBe(Date.UTC(2026, 8, 27))
    expect(startOfUtcDayMs(MIDNIGHT)).toBe(MIDNIGHT)
    expect(startOfUtcMonthMs(Date.UTC(2026, 8, 30, 23, 59))).toBe(Date.UTC(2026, 8, 1))
    expect(startOfUtcMonthMs(Date.UTC(2026, 9, 1))).toBe(Date.UTC(2026, 9, 1))
    expect(startOfNextUtcMonthMs(Date.UTC(2026, 11, 15))).toBe(Date.UTC(2027, 0, 1))
  })
})

describe('daily counters reset at UTC midnight', () => {
  const created: string[] = []
  function user(): string {
    const id = `u_tz_${nanoid(6)}`
    db.insert(users).values({ id, email: `${id}@test.local`, createdAt: Date.now() }).run()
    created.push(id)
    return id
  }
  function call(userId: string, task: string, createdAt: number, turnId?: string) {
    db.insert(aiCalls).values({ id: nanoid(), userId, task, provider: 'gemini', model: 'gemini-2.5-flash', success: 1, createdAt, ...(turnId ? { turnId } : {}) }).run()
  }
  afterEach(() => {
    for (const id of created.splice(0)) db.delete(users).where(eq(users.id, id)).run()
  })

  it('free reshuffles: 24 used at 23:59:59.999 UTC still count that day, and the count is 0 one ms later', async () => {
    const { countTodaySuggestReshuffles } = await import('../../src/transport/web/routes/discover.js')
    const u = user()
    for (let i = 0; i < 24; i++) call(u, 'suggest_reshuffle', JUST_BEFORE - i)
    expect(countTodaySuggestReshuffles(u, JUST_BEFORE)).toBe(24)
    expect(countTodaySuggestReshuffles(u, MIDNIGHT)).toBe(0)
  })

  it('free chat turns follow the same UTC day', async () => {
    const { countTodayChatTurns } = await import('../../src/agent/chatStore.js')
    const u = user()
    call(u, 'chat_turn', JUST_BEFORE, 'turn_a')
    expect(countTodayChatTurns(u, JUST_BEFORE)).toBe(1)
    call(u, 'chat_turn', MIDNIGHT, 'turn_b')
    expect(countTodayChatTurns(u, MIDNIGHT)).toBe(1) // turn_a was yesterday (UTC)
  })
})

describe('time zones', () => {
  it('normalizeTimeZone accepts IANA names and rejects anything else', () => {
    expect(normalizeTimeZone('America/Toronto')).toBe('America/Toronto')
    expect(normalizeTimeZone('UTC')).toBe('UTC')
    for (const bad of ['Mars/Olympus', '', ' ', 'x'.repeat(65), 'America/Toronto; DROP', 42, null, undefined, {}]) {
      expect(normalizeTimeZone(bad)).toBeUndefined()
    }
  })

  it('localTime gives the wall clock in the zone, falling back to UTC', () => {
    const at = new Date(Date.UTC(2026, 8, 28, 19, 30)) // Mon 19:30 UTC
    expect(localTime(at, 'America/Toronto')).toEqual({ hour: 15, weekday: 1, date: '2026-09-28', timeZone: 'America/Toronto' })
    expect(localTime(at, 'Asia/Tokyo')).toEqual({ hour: 4, weekday: 2, date: '2026-09-29', timeZone: 'Asia/Tokyo' })
    expect(localTime(at, 'Nope/Nowhere')).toEqual({ hour: 19, weekday: 1, date: '2026-09-28', timeZone: 'UTC' })
    expect(localTime(new Date(Date.UTC(2026, 8, 28, 0, 5)), 'UTC').hour).toBe(0)
  })
})

describe('agent time of day', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('../../src/ai/suggest.js')
    vi.doUnmock('../../src/tools/weather.js')
    vi.doUnmock('../../src/tools/items.js')
    vi.resetModules()
  })

  async function suggestWith(ctxZone: string | undefined, weatherZone: string | undefined) {
    vi.resetModules()
    const suggestOutfits = vi.fn().mockResolvedValue([])
    vi.doMock('../../src/ai/suggest.js', () => ({ suggestOutfits }))
    vi.doMock('../../src/tools/weather.js', () => ({
      getCurrentWeather: vi.fn().mockResolvedValue({
        temperature: 18, weatherCode: 1, condition: 'Clear', precipitation: 0, windSpeed: 5, icon: 'sun',
        ...(weatherZone ? { timezone: weatherZone } : {}),
      }),
      geocodeCity: vi.fn(),
    }))
    vi.doMock('../../src/tools/items.js', () => ({ listItems: vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]) }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 19, 30))) // Mon 19:30 UTC
    const { executeTool } = await import('../../src/agent/tools.js')
    await executeTool('suggest_outfit', { lat: 43.65, lon: -79.38 }, { userId: 'self', identity: {}, ...(ctxZone ? { timeZone: ctxZone } : {}) })
    const args = suggestOutfits.mock.calls[0]
    return { hour: args[5], weekday: args[6] }
  }

  it("suggest_outfit uses the chat user's zone, then the location's zone, then UTC", async () => {
    expect(await suggestWith('Asia/Tokyo', 'America/Toronto')).toEqual({ hour: 4, weekday: 2 })
    expect(await suggestWith(undefined, 'America/Toronto')).toEqual({ hour: 15, weekday: 1 })
    expect(await suggestWith(undefined, undefined)).toEqual({ hour: 19, weekday: 1 })
  })

  it("the system prompt's date is the user's local date", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 23, 30)))
    const { buildSystemPrompt } = await import('../../src/agent/loop.js')
    expect(buildSystemPrompt('self', [], 'Asia/Tokyo')).toContain('Today is 2026-09-29 (Asia/Tokyo).')
    expect(buildSystemPrompt('self', [])).toContain('Today is 2026-09-28 (UTC).')
  })
})
