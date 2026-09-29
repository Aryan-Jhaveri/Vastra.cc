import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { suggestEvents } from '../../src/db/schema.js'
import { logSuggestEvent } from '../../src/ai/suggestEvents.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_USER = 'suggest-events-test'

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).run()
})

describe('logSuggestEvent', () => {
  it('persists occasion when provided', () => {
    logSuggestEvent({
      userId: TEST_USER,
      shortlistSource: 'text',
      itemCount: 10,
      shortlistedCount: 5,
      suggestionCount: 3,
      preFilterEnabled: true,
      weather: 'Sunny, 22°C',
      occasion: 'work',
    })

    const rows = db.select().from(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].occasion).toBe('work')
  })

  it('persists NULL occasion when not provided', () => {
    logSuggestEvent({
      userId: TEST_USER,
      shortlistSource: 'text',
      itemCount: 10,
      shortlistedCount: 5,
      suggestionCount: 3,
      preFilterEnabled: false,
      weather: 'Sunny, 22°C',
    })

    const rows = db.select().from(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].occasion).toBeNull()
  })

  it('persists all fields correctly', () => {
    logSuggestEvent({
      userId: TEST_USER,
      shortlistSource: 'hybrid',
      itemCount: 42,
      shortlistedCount: 12,
      suggestionCount: 5,
      preFilterEnabled: true,
      weather: 'Rainy, 10°C',
      occasion: 'date',
      promptChars: 1500,
    })

    const row = db.select().from(suggestEvents).where(eq(suggestEvents.userId, TEST_USER)).get()!
    expect(row.shortlistSource).toBe('hybrid')
    expect(row.itemCount).toBe(42)
    expect(row.shortlistedCount).toBe(12)
    expect(row.suggestionCount).toBe(5)
    expect(row.preFilterEnabled).toBe(1)
    expect(row.weather).toBe('Rainy, 10°C')
    expect(row.occasion).toBe('date')
    expect(row.promptChars).toBe(1500)
    expect(row.id).toBeDefined()
    expect(row.createdAt).toBeGreaterThan(0)
  })
})