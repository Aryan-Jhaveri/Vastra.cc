import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as schema from '../../src/db/schema.js'
import { eq, and } from 'drizzle-orm'

const __dirname = dirname(fileURLToPath(import.meta.url))

let sqlite: InstanceType<typeof Database>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
})

afterAll(() => { sqlite.close() })

beforeEach(() => {
  const tables = [
    'tryon_results', 'item_images', 'collection_outfits',
    'push_subscriptions', 'job_runs', 'share_payloads',
    'outfits', 'collections', 'user_photos',
    'items', 'scheduled_jobs', 'settings',
    'discover_events', 'suggest_events', 'embeddings',
    'login_tokens', 'sessions', 'oauth_accounts', 'users',
  ]
  for (const t of new Set(tables)) {
    sqlite.exec(`DELETE FROM ${t}`)
  }
})

function createUser(email: string): string {
  const id = `user-${email.replace(/[^a-z0-9]/g, '')}`
  db.insert(schema.users).values({
    id,
    email: email.toLowerCase(),
    name: null,
    createdAt: Date.now(),
  }).run()
  return id
}

describe('is_admin column', () => {
  it('defaults to false for new users', () => {
    const userId = createUser('admin-test@test.com')
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
    expect(user?.isAdmin).toBe(false)
  })

  it('can be set to true', () => {
    const userId = createUser('admin-true@test.com')
    db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId)).run()
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
    expect(user?.isAdmin).toBe(true)
  })

  it('can be set back to false', () => {
    const userId = createUser('admin-toggle@test.com')
    db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId)).run()
    db.update(schema.users).set({ isAdmin: false }).where(eq(schema.users.id, userId)).run()
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get()
    expect(user?.isAdmin).toBe(false)
  })
})

describe('cross-user data isolation', () => {
  it('users see only their own items', () => {
    const userId1 = createUser('alice@test.com')
    const userId2 = createUser('bob@test.com')

    db.insert(schema.items).values({
      id: 'item-1',
      userId: userId1,
      imageUri: 'images/items/1.jpg',
      category: 'tops',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    db.insert(schema.items).values({
      id: 'item-2',
      userId: userId2,
      imageUri: 'images/items/2.jpg',
      category: 'bottoms',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    const user1Items = db.select().from(schema.items).where(eq(schema.items.userId, userId1)).all()
    expect(user1Items).toHaveLength(1)
    expect(user1Items[0].id).toBe('item-1')

    const user2Items = db.select().from(schema.items).where(eq(schema.items.userId, userId2)).all()
    expect(user2Items).toHaveLength(1)
    expect(user2Items[0].id).toBe('item-2')

    // Cross-check: user1 should NOT see user2's item when querying by user2's userId
    const user1SeesUser2 = db.select().from(schema.items)
      .where(and(eq(schema.items.userId, userId2), eq(schema.items.id, 'item-2')))
      .all()
    expect(user1SeesUser2).toHaveLength(1)
  })

  it('outfits are isolated per user', () => {
    const userId1 = createUser('carol@test.com')
    const userId2 = createUser('dan@test.com')

    db.insert(schema.outfits).values({
      id: 'outfit-1',
      userId: userId1,
      name: 'Summer Vibes',
      itemIds: '[]',
      createdAt: Date.now(),
    }).run()

    db.insert(schema.outfits).values({
      id: 'outfit-2',
      userId: userId2,
      name: 'Winter Coat',
      itemIds: '[]',
      createdAt: Date.now(),
    }).run()

    expect(db.select().from(schema.outfits).where(eq(schema.outfits.userId, userId1)).all()).toHaveLength(1)
    expect(db.select().from(schema.outfits).where(eq(schema.outfits.userId, userId2)).all()).toHaveLength(1)

    const user1Outfits = db.select().from(schema.outfits).where(eq(schema.outfits.userId, userId1)).all()
    expect(user1Outfits.map(o => o.name)).toEqual(['Summer Vibes'])
  })

  it('user photos are isolated per user', () => {
    const userId1 = createUser('eve@test.com')
    const userId2 = createUser('frank@test.com')

    db.insert(schema.userPhotos).values({
      id: 'photo-1',
      userId: userId1,
      imageUri: 'images/user/1.jpg',
      createdAt: Date.now(),
    }).run()

    db.insert(schema.userPhotos).values({
      id: 'photo-2',
      userId: userId2,
      imageUri: 'images/user/2.jpg',
      createdAt: Date.now(),
    }).run()

    expect(db.select().from(schema.userPhotos).where(eq(schema.userPhotos.userId, userId1)).all()).toHaveLength(1)
    expect(db.select().from(schema.userPhotos).where(eq(schema.userPhotos.userId, userId2)).all()).toHaveLength(1)
  })

  it('collections are isolated per user', () => {
    const userId1 = createUser('grace@test.com')
    const userId2 = createUser('hank@test.com')

    db.insert(schema.collections).values({
      id: 'col-1',
      userId: userId1,
      name: 'Summer',
      description: null,
      season: '[]',
      tags: '[]',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    db.insert(schema.collections).values({
      id: 'col-2',
      userId: userId2,
      name: 'Winter',
      description: null,
      season: '[]',
      tags: '[]',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    expect(db.select().from(schema.collections).where(eq(schema.collections.userId, userId1)).all()).toHaveLength(1)
    expect(db.select().from(schema.collections).where(eq(schema.collections.userId, userId2)).all()).toHaveLength(1)
  })

  it('self backfill user still works', () => {
    db.insert(schema.users).values({
      id: 'self',
      email: 'aryan@closet.local',
      name: null,
      createdAt: Date.now(),
    }).run()

    db.insert(schema.items).values({
      id: 'legacy-item',
      userId: 'self',
      imageUri: 'images/items/old.jpg',
      category: 'tops',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).run()

    const items = db.select().from(schema.items).where(eq(schema.items.userId, 'self')).all()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('legacy-item')
  })

  it('job_runs are isolated per user', () => {
    const userId1 = createUser('eve@test.com')
    const userId2 = createUser('frank@test.com')

    db.insert(schema.jobRuns).values({
      id: 'run-1',
      userId: userId1,
      jobId: 'job-x',
      firedAt: Date.now(),
      status: 'success',
      resultJson: JSON.stringify([{ name: 'Eve outfit', item_ids: [], reasoning: 'nice' }]),
    }).run()

    db.insert(schema.jobRuns).values({
      id: 'run-2',
      userId: userId2,
      jobId: 'job-y',
      firedAt: Date.now(),
      status: 'success',
      resultJson: JSON.stringify([{ name: 'Frank outfit', item_ids: [], reasoning: 'cool' }]),
    }).run()

    const user1Runs = db.select().from(schema.jobRuns).where(eq(schema.jobRuns.userId, userId1)).all()
    expect(user1Runs).toHaveLength(1)
    expect(user1Runs[0].id).toBe('run-1')

    const user2Runs = db.select().from(schema.jobRuns).where(eq(schema.jobRuns.userId, userId2)).all()
    expect(user2Runs).toHaveLength(1)
    expect(user2Runs[0].id).toBe('run-2')
  })

  it('settings are isolated per user', () => {
    const userId1 = createUser('grace@test.com')
    const userId2 = createUser('hank@test.com')

    db.insert(schema.settings).values({
      key: 'navWidth',
      userId: userId1,
      value: '280',
    }).run()

    db.insert(schema.settings).values({
      key: 'navWidth',
      userId: userId2,
      value: '320',
    }).run()

    const user1Setting = db.select().from(schema.settings)
      .where(and(eq(schema.settings.key, 'navWidth'), eq(schema.settings.userId, userId1)))
      .get()
    expect(user1Setting!.value).toBe('280')

    const user2Setting = db.select().from(schema.settings)
      .where(and(eq(schema.settings.key, 'navWidth'), eq(schema.settings.userId, userId2)))
      .get()
    expect(user2Setting!.value).toBe('320')

    const allForKey = db.select().from(schema.settings).where(eq(schema.settings.key, 'navWidth')).all()
    expect(allForKey).toHaveLength(2)
  })

  it('reserved __system__ settings are not visible to regular users', () => {
    const userId = createUser('ivan@test.com')

    // App-global row owned by the reserved system user.
    db.insert(schema.settings).values({
      key: 'password',
      userId: '__system__',
      value: 'admin-secret',
    }).run()

    db.insert(schema.settings).values({
      key: 'navWidth',
      userId,
      value: '300',
    }).run()

    // A user-scoped read for the 'password' key returns nothing for that user.
    const userPasswordRow = db.select().from(schema.settings)
      .where(and(eq(schema.settings.key, 'password'), eq(schema.settings.userId, userId)))
      .get()
    expect(userPasswordRow).toBeUndefined()

    // The system row is reachable only via the reserved id.
    const systemRow = db.select().from(schema.settings)
      .where(and(eq(schema.settings.key, 'password'), eq(schema.settings.userId, '__system__')))
      .get() as { value: string } | undefined
    expect(systemRow!.value).toBe('admin-secret')

    // Listing a user's settings never includes the system password row.
    const userRows = db.select().from(schema.settings)
      .where(eq(schema.settings.userId, userId)).all() as { key: string }[]
    expect(userRows.map(r => r.key)).not.toContain('password')
  })
})
