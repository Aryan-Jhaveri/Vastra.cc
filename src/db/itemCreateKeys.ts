import { nanoid } from 'nanoid'
import { getSqlite } from './client.js'
import { requireUserId } from './queries.js'

// #347 / #349 — idempotency keys for POST /api/items.
//
// The client sends one key per item it means to create. The first request
// claims the key (a lease), creates the item, then records the item id. A
// retry after a lost response replays that item instead of saving a duplicate.
//
// What this guarantees: a completed key never creates a second item, and two
// concurrent requests with one key can't both proceed. What it doesn't: if the
// process dies between inserting the item and recording it (back-to-back
// synchronous calls, so a crash window of microseconds), the lease expires and
// a retry creates the item again. Item creation makes no AI call, so that
// worst case duplicates an item and an image, never provider spend.

/** Longer than any normal create (image save + insert takes well under a second). */
export const ITEM_CREATE_LEASE_MS = 60_000

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/

export type ItemCreateClaim =
  | { kind: 'claimed'; token: string }
  | { kind: 'replay'; itemId: string }
  | { kind: 'in_progress' }

export function claimItemCreateKey(userId: string, key: string, now = Date.now()): ItemCreateClaim {
  requireUserId(userId)
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw new Error('Invalid idempotency key')
  const sqlite = getSqlite()
  // BEGIN IMMEDIATE serialises read-then-claim across connections, as in
  // src/jobs/claims.ts and the chat turn lease.
  return sqlite.transaction((): ItemCreateClaim => {
    const row = sqlite.prepare('SELECT item_id AS itemId, expires_at AS expiresAt FROM item_create_keys WHERE user_id = ? AND key = ?')
      .get(userId, key) as { itemId: string | null; expiresAt: number } | undefined
    if (row?.itemId) return { kind: 'replay', itemId: row.itemId }
    if (row && row.expiresAt > now) return { kind: 'in_progress' }
    // New key, or an abandoned lease from a crashed attempt: take it over.
    const token = nanoid()
    sqlite.prepare(`INSERT INTO item_create_keys (user_id, key, item_id, token, expires_at, created_at)
      VALUES (?, ?, NULL, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`)
      .run(userId, key, token, now + ITEM_CREATE_LEASE_MS, now)
    return { kind: 'claimed', token }
  }).immediate()
}

/** Token-fenced: returns false if the lease was taken over in the meantime. */
export function completeItemCreateKey(userId: string, key: string, token: string, itemId: string): boolean {
  requireUserId(userId)
  const result = getSqlite()
    .prepare('UPDATE item_create_keys SET item_id = ? WHERE user_id = ? AND key = ? AND token = ? AND item_id IS NULL')
    .run(itemId, userId, key, token)
  return result.changes === 1
}

/** Frees a failed attempt's lease so the client can retry at once. Token-fenced. */
export function releaseItemCreateKey(userId: string, key: string, token: string): void {
  requireUserId(userId)
  getSqlite()
    .prepare('DELETE FROM item_create_keys WHERE user_id = ? AND key = ? AND token = ? AND item_id IS NULL')
    .run(userId, key, token)
}
