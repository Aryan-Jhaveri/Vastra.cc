import { db } from '../db/client.js'
import { pushSubscriptions } from '../db/schema.js'
import { eq, and, asc } from 'drizzle-orm'
import { requireUserId } from '../db/queries.js'
import { nanoid } from 'nanoid'

export type PushSubscription = typeof pushSubscriptions.$inferSelect

/** Devices per user; the oldest is dropped when a new one subscribes. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10

export function upsertPushSubscription(endpoint: string, keys: { auth: string; p256dh: string }, userId: string): PushSubscription {
  requireUserId(userId)
  const existing = db.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
    .get()
  if (existing) {
    return db.update(pushSubscriptions)
      .set({ keys: JSON.stringify(keys) })
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
      .returning()
      .get() as PushSubscription
  }
  const mine = db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId)).orderBy(asc(pushSubscriptions.createdAt)).all()
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER + 1))) {
    db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, old.id), eq(pushSubscriptions.userId, userId))).run()
  }
  return db.insert(pushSubscriptions).values({
    id: nanoid(),
    userId,
    endpoint,
    keys: JSON.stringify(keys),
    createdAt: Date.now(),
  }).returning().get() as PushSubscription
}

export function deletePushSubscription(endpoint: string, userId: string): void {
  requireUserId(userId)
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId))).run()
}

export function getAllPushSubscriptions(userId: string): PushSubscription[] {
  requireUserId(userId)
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all() as PushSubscription[]
}
