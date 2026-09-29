import { db } from '../db/client.js'
import { sharePayloads } from '../db/schema.js'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { snapshotImageForShare } from '../storage/images.js'

export type SharePayload = typeof sharePayloads.$inferSelect

export interface CreateShareInput {
  source: 'outfit' | 'suggestion' | 'inspiration' | 'manual'
  sourceRef?: string
  description: string
  imageUris?: string[]
  senderHandle?: string
  expiresInDays?: number
}

const DEFAULT_EXPIRY_DAYS = 30

export async function createSharePayload(input: CreateShareInput, userId: string): Promise<SharePayload> {
  const id = nanoid()
  const now = Date.now()
  const expiresAt = now + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000

  const snapshotted: string[] = []
  for (const uri of (input.imageUris ?? [])) {
    const copied = await snapshotImageForShare(uri, id, userId)
    if (copied) snapshotted.push(copied)
  }

  return db.insert(sharePayloads).values({
    id,
    userId,
    createdByUserId: userId,
    createdAt: now,
    expiresAt,
    source: input.source,
    sourceRef: input.sourceRef,
    description: input.description,
    imageUris: JSON.stringify(snapshotted),
    senderHandle: input.senderHandle,
    visibility: 'link',
    openCount: 0,
  }).returning().get() as SharePayload
}

export function getSharePayload(id: string): SharePayload | undefined {
  return db.select().from(sharePayloads).where(eq(sharePayloads.id, id)).get() as SharePayload | undefined
}

export function deleteSharePayload(id: string): void {
  db.delete(sharePayloads).where(eq(sharePayloads.id, id)).run()
}

export interface CreateShareInboxInput {
  userId: string                  // the authenticated userId, or '__anon__' for anonymous shares
  imageUri: string                // an already-saved path, e.g. "images/share-inbox/abc.jpg"
  expiresAt: number
  claimToken?: string | null      // only set on anonymous rows
  intendedAction?: string | null  // null in Phase 1 — the in-app chooser resolves it
}

/**
 * Create an inbound share row from the PWA share-target. Unlike createSharePayload,
 * the image is already persisted (saved by the route before this call), so we store
 * the URI verbatim — no snapshot copy. source is always 'share_inbox'.
 */
export function createShareInboxPayload(input: CreateShareInboxInput): SharePayload {
  const id = nanoid()
  const now = Date.now()
  return db.insert(sharePayloads).values({
    id,
    userId: input.userId,
    createdByUserId: input.userId,
    createdAt: now,
    expiresAt: input.expiresAt,
    source: 'share_inbox',
    description: 'Shared image',
    imageUris: JSON.stringify([input.imageUri]),
    visibility: 'link',
    intendedAction: input.intendedAction ?? null,
    claimToken: input.claimToken ?? null,
    openCount: 0,
  }).returning().get() as SharePayload
}

/**
 * Transfer ownership of an anonymous share_inbox row to a real user after login.
 * Clears the claim token and extends the expiry to the normal default. The image
 * file move between user trees is the caller's responsibility (storage layer).
 */
// Atomic conditional claim: only an unexpired anonymous row whose claim token
// matches is transferred. Returns false when another request already claimed it
// (or the token/expiry no longer match), so concurrent claims can't both win.
export function claimSharePayload(
  id: string,
  claimToken: string,
  newUserId: string,
  newExpiresAt: number,
  now = Date.now(),
): boolean {
  const res = db.update(sharePayloads)
    .set({
      userId: newUserId,
      createdByUserId: newUserId,
      claimToken: null,
      expiresAt: newExpiresAt,
    })
    .where(and(
      eq(sharePayloads.id, id),
      eq(sharePayloads.userId, '__anon__'),
      eq(sharePayloads.claimToken, claimToken),
      or(isNull(sharePayloads.expiresAt), gt(sharePayloads.expiresAt, now)),
    ))
    .run()
  return res.changes === 1
}

export function markShareOpened(id: string): void {
  const payload = getSharePayload(id)
  if (!payload) return
  db.update(sharePayloads)
    .set({
      openedAt: payload.openedAt ?? Date.now(),
      openCount: (payload.openCount ?? 0) + 1,
    })
    .where(eq(sharePayloads.id, id))
    .run()
}

export function listMySharePayloads(userId: string): SharePayload[] {
  return db.select().from(sharePayloads)
    .where(eq(sharePayloads.userId, userId))
    .all() as SharePayload[]
}
