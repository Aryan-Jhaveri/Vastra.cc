import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../../src/db/client.js'
import { users, items, itemCreateKeys } from '../../src/db/schema.js'
import {
  claimItemCreateKey, completeItemCreateKey, releaseItemCreateKey, ITEM_CREATE_LEASE_MS,
} from '../../src/db/itemCreateKeys.js'

// #347 / #349 — POST /api/items idempotency keys, against the real DB.

const __dirname = dirname(fileURLToPath(import.meta.url))
const A = 'idem-user-a'
const B = 'idem-user-b'
const KEY = 'review-item-key-0001'

function seedItem(userId: string): string {
  const id = nanoid()
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: Date.now(), updatedAt: Date.now() }).run()
  return id
}

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

beforeEach(() => {
  db.delete(itemCreateKeys).run()
})

describe('item create keys', () => {
  it('claims a new key, then replays the completed item', () => {
    const claim = claimItemCreateKey(A, KEY)
    expect(claim.kind).toBe('claimed')
    const itemId = seedItem(A)
    expect(completeItemCreateKey(A, KEY, (claim as { token: string }).token, itemId)).toBe(true)
    expect(claimItemCreateKey(A, KEY)).toEqual({ kind: 'replay', itemId })
  })

  it('reports in_progress while another attempt holds the lease', () => {
    const now = 1_000_000
    expect(claimItemCreateKey(A, KEY, now).kind).toBe('claimed')
    expect(claimItemCreateKey(A, KEY, now + 1).kind).toBe('in_progress')
  })

  it('lets a retry take over a crashed attempt once its lease expires', () => {
    const now = 1_000_000
    const first = claimItemCreateKey(A, KEY, now) as { token: string }
    const second = claimItemCreateKey(A, KEY, now + ITEM_CREATE_LEASE_MS + 1)
    expect(second.kind).toBe('claimed')
    // The crashed attempt can no longer complete or release the new owner's lease.
    expect(completeItemCreateKey(A, KEY, first.token, seedItem(A))).toBe(false)
    releaseItemCreateKey(A, KEY, first.token)
    expect(claimItemCreateKey(A, KEY, now + ITEM_CREATE_LEASE_MS + 2).kind).toBe('in_progress')
  })

  it('release frees the key for an immediate retry', () => {
    const claim = claimItemCreateKey(A, KEY) as { token: string }
    releaseItemCreateKey(A, KEY, claim.token)
    expect(claimItemCreateKey(A, KEY).kind).toBe('claimed')
  })

  it('release never removes a completed replay record', () => {
    const claim = claimItemCreateKey(A, KEY) as { token: string }
    const itemId = seedItem(A)
    completeItemCreateKey(A, KEY, claim.token, itemId)
    releaseItemCreateKey(A, KEY, claim.token)
    expect(claimItemCreateKey(A, KEY)).toEqual({ kind: 'replay', itemId })
  })

  it('deleting the item deletes its key, so the same key creates again', () => {
    const claim = claimItemCreateKey(A, KEY) as { token: string }
    const itemId = seedItem(A)
    completeItemCreateKey(A, KEY, claim.token, itemId)
    db.delete(items).where(eq(items.id, itemId)).run()
    expect(claimItemCreateKey(A, KEY).kind).toBe('claimed')
  })

  it('cross-user isolation: the same key is independent per user', () => {
    const claim = claimItemCreateKey(A, KEY) as { token: string }
    completeItemCreateKey(A, KEY, claim.token, seedItem(A))
    expect(claimItemCreateKey(B, KEY).kind).toBe('claimed')
  })

  it('requires a userId and a well-formed key', () => {
    expect(() => claimItemCreateKey('', KEY)).toThrow(/userId/)
    expect(() => claimItemCreateKey(A, 'short')).toThrow(/idempotency key/)
    expect(() => claimItemCreateKey(A, 'bad key with spaces')).toThrow(/idempotency key/)
  })
})
