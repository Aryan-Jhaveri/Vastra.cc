import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { db } from '../../src/db/client.js'
import { discoverEvents } from '../../src/db/schema.js'
import { logDiscoverEvent } from '../../src/ai/discoverEvents.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_USER = 'discover-events-test'

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

beforeEach(() => {
  db.delete(discoverEvents).where(eq(discoverEvents.userId, TEST_USER)).run()
})

describe('logDiscoverEvent', () => {
  it('persists occasion when provided', () => {
    logDiscoverEvent({
      userId: TEST_USER,
      mode: 'prompt',
      shortlistSource: 'text',
      itemCount: 20,
      shortlistedCount: 8,
      suggestionCount: 4,
      preFilterEnabled: true,
      occasion: 'formal',
    })

    const rows = db.select().from(discoverEvents).where(eq(discoverEvents.userId, TEST_USER)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].occasion).toBe('formal')
  })

  it('persists NULL occasion when not provided', () => {
    logDiscoverEvent({
      userId: TEST_USER,
      mode: 'image',
      shortlistSource: 'outfit_retrieval',
      itemCount: 15,
      shortlistedCount: 6,
      suggestionCount: 2,
      preFilterEnabled: false,
    })

    const rows = db.select().from(discoverEvents).where(eq(discoverEvents.userId, TEST_USER)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].occasion).toBeNull()
  })

  it('persists all fields correctly', () => {
    logDiscoverEvent({
      userId: TEST_USER,
      mode: 'shared',
      shortlistSource: 'hybrid',
      itemCount: 30,
      shortlistedCount: 10,
      suggestionCount: 3,
      preFilterEnabled: true,
      occasion: 'casual',
      promptChars: 2000,
    })

    const row = db.select().from(discoverEvents).where(eq(discoverEvents.userId, TEST_USER)).get()!
    expect(row.mode).toBe('shared')
    expect(row.shortlistSource).toBe('hybrid')
    expect(row.itemCount).toBe(30)
    expect(row.shortlistedCount).toBe(10)
    expect(row.suggestionCount).toBe(3)
    expect(row.preFilterEnabled).toBe(1)
    expect(row.occasion).toBe('casual')
    expect(row.promptChars).toBe(2000)
    expect(row.id).toBeDefined()
    expect(row.createdAt).toBeGreaterThan(0)
  })
})