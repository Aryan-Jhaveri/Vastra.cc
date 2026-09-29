import { db } from './client.js'
import { items, outfits, userPhotos, tryonResults, settings, collections, collectionOutfits, itemImages, users, sessions, loginTokens, oauthAccounts, sharePayloads, jobRuns, scheduledJobs, pushSubscriptions, suggestEvents, discoverEvents, embeddings, apiTokens } from './schema.js'
import { eq, like, desc, inArray, and, or, sql, type AnyColumn } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { hostedHooks } from '../hostedHooks.js'
import type {
  Item, NewItem, Outfit, NewOutfit, UserPhoto, TryonResult, NewTryonResult,
  Collection, NewCollection,
} from '../types/index.js'

// ─── Users ────────────────────────────────────────────────────────────────────

export function getUser(id: string): typeof users.$inferSelect | undefined {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function getUserById(id: string): typeof users.$inferSelect | undefined {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function getUserByEmail(email: string): typeof users.$inferSelect | undefined {
  return db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
}

export function createUser(email: string, passwordHash?: string | null, name?: string): typeof users.$inferSelect {
  return db.transaction((tx) => {
    const user = tx.insert(users).values({
      id: nanoid(),
      email: email.toLowerCase(),
      name: name ?? null,
      passwordHash: passwordHash ?? null,
      createdAt: Date.now(),
    }).returning().get()
    hostedHooks().onUserCreated(tx, user.id)
    return user
  })
}

export function setUserPassword(userId: string, passwordHash: string): void {
  db.update(users).set({ passwordHash }).where(eq(users.id, userId)).run()
}

/** Record one-time Terms of Service / Privacy Policy acceptance for a user. */
export function setUserAcceptedTerms(userId: string, ts: number = Date.now()): void {
  db.update(users).set({ acceptedTermsAt: ts }).where(eq(users.id, userId)).run()
}

export function setUserName(userId: string, name: string): void {
  db.update(users).set({ name }).where(eq(users.id, userId)).run()
}

export function setUserAdmin(email: string, isAdmin: boolean): boolean {
  const result = db.update(users).set({ isAdmin }).where(eq(users.email, email.toLowerCase())).run()
  return result.changes > 0
}

export function isUserAdmin(userId: string): boolean {
  const user = db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).get()
  return user?.isAdmin ?? false
}

/**
 * Permanently delete a user and ALL of their data rows, transactionally.
 *
 * Most per-user tables carry a `user_id` column with NO foreign key to
 * `users`, so deleting the `users` row alone would orphan them. We therefore
 * delete every per-user table explicitly (mirroring admin.mjs `deleteUser`),
 * child-first. Tables that DO have an ON DELETE CASCADE FK to `users`
 * (sessions, oauth_accounts, user_wallets, wallet_ledger, ai_calls,
 * analytics_events, api_tokens) are cleared by the final `users` delete.
 *
 * Does NOT touch the filesystem — callers must also remove the user's image
 * directory via `deleteUserImageDirectory` (account deletion does both).
 * Does NOT revoke the OpenRouter key — callers must do that BEFORE calling
 * this (fail-closed), so a revoke failure leaves all data intact.
 */
export function deleteUserAccount(userId: string): void {
  const user = db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).get()
  if (!user) return

  db.transaction((tx) => {
    // share_payloads — user can appear in any of three columns
    tx.delete(sharePayloads).where(or(
      eq(sharePayloads.userId, userId),
      eq(sharePayloads.createdByUserId, userId),
      eq(sharePayloads.recipientUserId, userId),
    )).run()

    // collection_outfits (via this user's collections) → collections
    const collectionIds = tx.select({ id: collections.id }).from(collections)
      .where(eq(collections.userId, userId)).all().map(r => r.id)
    if (collectionIds.length) {
      tx.delete(collectionOutfits).where(inArray(collectionOutfits.collectionId, collectionIds)).run()
    }
    tx.delete(collections).where(eq(collections.userId, userId)).run()

    tx.delete(jobRuns).where(eq(jobRuns.userId, userId)).run()
    tx.delete(scheduledJobs).where(eq(scheduledJobs.userId, userId)).run()
    tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run()
    tx.delete(tryonResults).where(eq(tryonResults.userId, userId)).run()
    tx.delete(itemImages).where(eq(itemImages.userId, userId)).run()
    tx.delete(outfits).where(eq(outfits.userId, userId)).run()
    tx.delete(items).where(eq(items.userId, userId)).run()
    tx.delete(userPhotos).where(eq(userPhotos.userId, userId)).run()
    tx.delete(suggestEvents).where(eq(suggestEvents.userId, userId)).run()
    tx.delete(discoverEvents).where(eq(discoverEvents.userId, userId)).run()
    tx.delete(embeddings).where(eq(embeddings.userId, userId)).run()
    tx.delete(settings).where(eq(settings.userId, userId)).run()
    tx.delete(loginTokens).where(eq(loginTokens.email, user.email)).run()

    // users — cascades to sessions, oauth_accounts, user_wallets,
    // wallet_ledger, ai_calls, analytics_events via ON DELETE CASCADE.
    tx.delete(users).where(eq(users.id, userId)).run()
  })
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/** SHA-256 hex of a session token: what the sessions table stores and looks up by (#360). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type Session = typeof sessions.$inferSelect

/** Creates a session. `token` is returned once, for the cookie / bearer client; only its hash is stored. */
export function createSession(userId: string, hoursValid: number = 6): Session & { token: string } {
  const token = randomBytes(36).toString('base64url')
  const row = db.insert(sessions).values({
    id: nanoid(),
    userId,
    tokenHash: hashSessionToken(token),
    createdAt: Date.now(),
    expiresAt: Date.now() + hoursValid * 60 * 60 * 1000,
  }).returning().get()
  return { ...row, token }
}

export function getSessionByToken(token: string): Session | undefined {
  return db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).get()
}

export function deleteSession(token: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token))).run()
}

export function deleteUserSessions(userId: string): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run()
}

// ─── OAuth Accounts ───────────────────────────────────────────────────────────

export function getOAuthAccount(provider: string, providerId: string): typeof oauthAccounts.$inferSelect | undefined {
  return db.select().from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.providerId, providerId)))
    .get()
}

export function linkOAuthAccount(userId: string, provider: string, providerId: string): void {
  db.insert(oauthAccounts).values({
    id: nanoid(),
    userId,
    provider,
    providerId,
    createdAt: Date.now(),
  }).onConflictDoNothing({ target: [oauthAccounts.provider, oauthAccounts.providerId] }).run()
}

// ─── Login Tokens ─────────────────────────────────────────────────────────────

export function createLoginToken(email: string): typeof loginTokens.$inferSelect {
  return db.insert(loginTokens).values({
    id: nanoid(),
    email: email.toLowerCase(),
    token: nanoid(48),
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
  }).returning().get()
}

export function getLoginToken(token: string): typeof loginTokens.$inferSelect | undefined {
  return db.select().from(loginTokens).where(eq(loginTokens.token, token)).get()
}

export function consumeLoginToken(token: string): void {
  db.update(loginTokens).set({ usedAt: Date.now() }).where(eq(loginTokens.token, token)).run()
}

// ─── Items ───────────────────────────────────────────────────────────────────

// Callers supply identity from authenticated context, never from request data.
export function requireUserId(userId: string): void {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Authenticated userId is required')
  }
}

export function getAllItems(userId: string): Item[] {
  requireUserId(userId)
  return db.select().from(items)
    .where(eq(items.userId, userId))
    .orderBy(desc(items.createdAt))
    .all() as Item[]
}

export function getUniqueTags(userId: string): string[] {
  requireUserId(userId)
  const rows = db.select({ tags: items.tags }).from(items)
    .where(eq(items.userId, userId))
    .all() as { tags: string }[]
  const tagSet = new Set<string>()
  for (const row of rows) {
    try {
      (JSON.parse(row.tags ?? '[]') as string[]).forEach(t => tagSet.add(t))
    } catch { /* ignore malformed rows */ }
  }
  return [...tagSet].sort()
}

export function getUniqueSubcategories(userId: string): string[] {
  requireUserId(userId)
  const rows = db.select({ subcategory: items.subcategory }).from(items)
    .where(eq(items.userId, userId))
    .all() as { subcategory: string | null }[]
  const set = new Set<string>()
  for (const row of rows) {
    if (row.subcategory) set.add(row.subcategory)
  }
  return [...set].sort()
}

export function getUniqueCategories(userId: string): string[] {
  requireUserId(userId)
  const rows = db.select({ category: items.category }).from(items)
    .where(eq(items.userId, userId))
    .all() as { category: string }[]
  return [...new Set(rows.map(r => r.category).filter(Boolean))].sort()
}

export function getItem(id: string, userId: string): Item | undefined {
  requireUserId(userId)
  return db.select().from(items).where(and(eq(items.id, id), eq(items.userId, userId))).get() as Item | undefined
}

export function getItemsByCategory(category: string, userId: string): Item[] {
  requireUserId(userId)
  return db.select().from(items)
    .where(and(eq(items.category, category), eq(items.userId, userId)))
    .all() as Item[]
}

export function getItemsByColor(color: string, userId: string): Item[] {
  requireUserId(userId)
  return db.select().from(items)
    .where(and(like(items.colors, `%${color}%`), eq(items.userId, userId)))
    .all() as Item[]
}

export function getItemsBySeason(season: string, userId: string): Item[] {
  requireUserId(userId)
  return db.select().from(items)
    .where(and(like(items.season, `%${season}%`), eq(items.userId, userId)))
    .all() as Item[]
}

export function getItemsByOccasion(occasion: string, userId: string): Item[] {
  requireUserId(userId)
  return db.select().from(items)
    .where(and(like(items.occasion, `%${occasion}%`), eq(items.userId, userId)))
    .all() as Item[]
}

/** Characters stripped from both sides so "trench coat" ⇄ "trenchcoat" and "t-shirt" ⇄ "tshirt". */
const SEARCH_JOINERS = [' ', '-', '_', '.', '/', "'"]

/** Escape LIKE wildcards so user input is matched literally (paired with ESCAPE '\\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`)
}

/**
 * Split a free-text query into normalized search tokens: lowercased, split on
 * whitespace/commas, joiner punctuation removed ("t-shirt" → "tshirt"), and a
 * simple plural "s" dropped ("coats" → "coat", but "dress" stays). Tokens with
 * no letters/digits left (e.g. a bare "%") are discarded.
 */
export function searchTokens(query: string): string[] {
  return query.toLowerCase()
    .split(/[\s,;]+/)
    .map(t => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .map(t => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter(t => t.length > 0)
}

/** lower(col) with SEARCH_JOINERS removed, as an SQL expression. */
function compactColumn(col: AnyColumn) {
  let expr = sql`lower(coalesce(${col}, ''))`
  for (const ch of SEARCH_JOINERS) expr = sql`replace(${expr}, ${ch}, '')`
  return expr
}

/**
 * Free-text closet search (#364).
 *
 * Matching is token-based and normalized on both sides: every query token must
 * appear (AND) somewhere in the item, and each token may hit ANY searchable
 * field (category, subcategory, brand, colors, tags, AI description). AND keeps
 * "blue jacket" from returning every blue thing plus every jacket; per-token
 * field OR means the words don't need to sit in the same column. Spaces and
 * hyphens are ignored on both sides, so "trenchcoat" finds "trench coat".
 */
export function searchItems(query: string, userId: string): Item[] {
  requireUserId(userId)
  const tokens = searchTokens(query)
  if (tokens.length === 0) return []
  const fields = [
    items.category, items.subcategory, items.brand, items.primaryColor,
    items.colors, items.tags, items.aiDescription,
  ].map(compactColumn)
  const tokenConds = tokens.map(tok => {
    const pattern = `%${escapeLike(tok)}%`
    return or(...fields.map(f => sql`${f} LIKE ${pattern} ESCAPE '\\'`))
  })
  return db.select().from(items).where(and(
    eq(items.userId, userId),
    ...tokenConds,
  )).all() as Item[]
}

export function insertItem(data: Omit<NewItem, 'id' | 'createdAt' | 'updatedAt'> & { userId: string }): Item {
  requireUserId(data.userId)
  const now = Date.now()
  return db.insert(items).values({
    id: nanoid(),
    ...data,
    createdAt: now,
    updatedAt: now,
  }).returning().get() as Item
}

export function updateItem(id: string, userId: string, data: Partial<Omit<NewItem, 'id' | 'userId' | 'createdAt'>>): Item | undefined {
  requireUserId(userId)
  return db.update(items)
    .set({ ...data, id, userId, updatedAt: Date.now() })
    .where(and(eq(items.id, id), eq(items.userId, userId)))
    .returning().get() as Item | undefined
}

export function deleteItem(id: string, userId: string): void {
  requireUserId(userId)
  db.delete(items).where(and(eq(items.id, id), eq(items.userId, userId))).run()
}

export function markItemWorn(id: string, userId: string): Item | undefined {
  requireUserId(userId)
  return db.update(items)
    .set({
      timesWorn: sql`${items.timesWorn} + 1`,
      lastWornAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(and(eq(items.id, id), eq(items.userId, userId)))
    .returning().get() as Item | undefined
}

// ─── Outfits ─────────────────────────────────────────────────────────────────

export function getAllOutfits(userId: string): Outfit[] {
  requireUserId(userId)
  return db.select().from(outfits)
    .where(eq(outfits.userId, userId))
    .orderBy(desc(outfits.createdAt))
    .all() as Outfit[]
}

export function getOutfit(id: string, userId: string): Outfit | undefined {
  requireUserId(userId)
  return db.select().from(outfits).where(and(eq(outfits.id, id), eq(outfits.userId, userId))).get() as Outfit | undefined
}

export function getOutfitWithItems(id: string, userId: string): (Outfit & { items: Item[] }) | null {
  const outfit = getOutfit(id, userId)
  if (!outfit) return null
  const ids = JSON.parse(outfit.itemIds) as string[]
  const outfitItems = ids.length
    ? (db.select().from(items).where(and(inArray(items.id, ids), eq(items.userId, userId))).all() as Item[])
    : []
  return { ...outfit, items: outfitItems }
}

// Returns the subset of `ids` that exist and belong to `userId`. Used to reject
// outfits that reference another tenant's items.
export function getOwnedItemIds(ids: string[], userId: string): Set<string> {
  requireUserId(userId)
  if (ids.length === 0) return new Set()
  const rows = db.select({ id: items.id }).from(items)
    .where(and(inArray(items.id, ids), eq(items.userId, userId))).all()
  return new Set(rows.map(r => r.id))
}

export function insertOutfit(data: Omit<NewOutfit, 'id' | 'createdAt' | 'updatedAt'> & { userId: string }): Outfit {
  requireUserId(data.userId)
  const now = Date.now()
  return db.insert(outfits).values({
    id: nanoid(),
    ...data,
    createdAt: now,
    updatedAt: now,
  }).returning().get() as Outfit
}

export function updateOutfit(id: string, userId: string, data: Partial<Omit<NewOutfit, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>): Outfit | undefined {
  requireUserId(userId)
  return db.update(outfits)
    .set({ ...data, id, userId, updatedAt: Date.now() })
    .where(and(eq(outfits.id, id), eq(outfits.userId, userId)))
    .returning().get() as Outfit | undefined
}

export function deleteOutfit(id: string, userId: string): void {
  requireUserId(userId)
  db.delete(outfits).where(and(eq(outfits.id, id), eq(outfits.userId, userId))).run()
}

export function markOutfitWorn(id: string, userId: string): Outfit | undefined {
  requireUserId(userId)
  return db.update(outfits)
    .set({
      timesWorn: sql`${outfits.timesWorn} + 1`,
      lastWornAt: Date.now(),
    })
    .where(and(eq(outfits.id, id), eq(outfits.userId, userId)))
    .returning().get() as Outfit | undefined
}

// ─── User Photos ─────────────────────────────────────────────────────────────

export function getUserPhotos(userId: string): UserPhoto[] {
  return db.select().from(userPhotos)
    .where(eq(userPhotos.userId, userId))
    .orderBy(desc(userPhotos.createdAt))
    .all() as UserPhoto[]
}

export function getPrimaryUserPhoto(userId: string): UserPhoto | undefined {
  return db.select().from(userPhotos)
    .where(and(eq(userPhotos.isPrimary, 1), eq(userPhotos.userId, userId)))
    .get() as UserPhoto | undefined
}

export function insertUserPhoto(data: { userId: string; imageUri: string; label?: string; isPrimary?: number }): UserPhoto {
  return db.insert(userPhotos).values({
    id: nanoid(),
    userId: data.userId,
    imageUri: data.imageUri,
    label: data.label,
    isPrimary: data.isPrimary ?? 0,
    createdAt: Date.now(),
  }).returning().get() as UserPhoto
}

export function setPrimaryPhoto(id: string, userId: string): UserPhoto | undefined {
  db.update(userPhotos).set({ isPrimary: 0 }).where(eq(userPhotos.userId, userId)).run()
  return db.update(userPhotos)
    .set({ isPrimary: 1 })
    .where(and(eq(userPhotos.id, id), eq(userPhotos.userId, userId)))
    .returning().get() as UserPhoto | undefined
}

export function deleteUserPhoto(id: string, userId: string): void {
  db.delete(userPhotos).where(and(eq(userPhotos.id, id), eq(userPhotos.userId, userId))).run()
}

// ─── Tryon Results ────────────────────────────────────────────────────────────

export function getTryonResults(userId: string): TryonResult[] {
  return db.select().from(tryonResults)
    .where(eq(tryonResults.userId, userId))
    .orderBy(desc(tryonResults.createdAt))
    .all() as TryonResult[]
}

export function insertTryonResult(userId: string, data: Omit<NewTryonResult, 'id' | 'createdAt' | 'userId'>): TryonResult {
  return db.insert(tryonResults).values({
    id: nanoid(),
    userId,
    ...data,
    createdAt: Date.now(),
  }).returning().get() as TryonResult
}

export function deleteTryonResult(id: string, userId: string): void {
  db.delete(tryonResults).where(and(eq(tryonResults.id, id), eq(tryonResults.userId, userId))).run()
}

export function updateTryonResult(id: string, userId: string, data: { outfitId: string }): TryonResult | undefined {
  return db.update(tryonResults)
    .set(data)
    .where(and(eq(tryonResults.id, id), eq(tryonResults.userId, userId)))
    .returning().get() as TryonResult | undefined
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// Convention: getSetting/getSettings/setSetting are PER-USER and must only ever
// be called with a real user's id. They must NOT read or write the reserved
// '__system__' user_id — that row holds genuine app-globals (e.g. the admin
// fallback password) and is reachable only through getSystemSetting /
// setSystemSetting below. Keeping the two paths separate is what prevents a
// logged-in user hitting /api/settings from clobbering the admin password.
export function getSetting(key: string, userId: string): string | null {
  const row = db.select().from(settings)
    .where(and(eq(settings.key, key), eq(settings.userId, userId)))
    .get() as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string, userId: string): void {
  db.insert(settings).values({ key, userId, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
    .run()
}

// Reserved user_id for app-global settings that belong to no single user.
const SYSTEM_USER_ID = '__system__'

// System globals — NOT exported through src/settings.ts, so they can never flow
// through the user-facing /api/settings routes. Use only for genuine app-wide
// values such as the admin fallback password.
export function getSystemSetting(key: string): string | null {
  const row = db.select().from(settings)
    .where(and(eq(settings.key, key), eq(settings.userId, SYSTEM_USER_ID)))
    .get() as { value: string } | undefined
  return row?.value ?? null
}

export function setSystemSetting(key: string, value: string): void {
  db.insert(settings).values({ key, userId: SYSTEM_USER_ID, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
    .run()
}

// ─── Collections ──────────────────────────────────────────────────────────────

export function getAllCollections(userId: string): Collection[] {
  return db.select().from(collections)
    .where(eq(collections.userId, userId))
    .orderBy(desc(collections.createdAt))
    .all() as Collection[]
}

export function getCollection(id: string, userId: string): Collection | undefined {
  return db.select().from(collections).where(and(eq(collections.id, id), eq(collections.userId, userId))).get() as Collection | undefined
}

export function insertCollection(data: Omit<NewCollection, 'id' | 'createdAt' | 'updatedAt'>): Collection {
  const now = Date.now()
  return db.insert(collections).values({
    id: nanoid(),
    ...data,
    createdAt: now,
    updatedAt: now,
  }).returning().get() as Collection
}

export function updateCollection(id: string, userId: string, data: Partial<Omit<NewCollection, 'id' | 'createdAt'>>): Collection | undefined {
  return db.update(collections)
    .set({ ...data, updatedAt: Date.now() })
    .where(and(eq(collections.id, id), eq(collections.userId, userId)))
    .returning().get() as Collection | undefined
}

export function deleteCollection(id: string, userId: string): void {
  requireUserId(userId)
  db.transaction(tx => {
    tx.delete(collectionOutfits).where(inArray(collectionOutfits.collectionId,
      tx.select({ id: collections.id }).from(collections)
        .where(and(eq(collections.id, id), eq(collections.userId, userId))),
    )).run()
    tx.delete(collections).where(and(eq(collections.id, id), eq(collections.userId, userId))).run()
  })
}

export function getOutfitIdsInCollection(collectionId: string, userId: string): string[] {
  requireUserId(userId)
  const rows = db.select({ outfitId: collectionOutfits.outfitId })
    .from(collectionOutfits)
    .innerJoin(collections, eq(collections.id, collectionOutfits.collectionId))
    .innerJoin(outfits, eq(outfits.id, collectionOutfits.outfitId))
    .where(and(
      eq(collectionOutfits.collectionId, collectionId),
      eq(collections.userId, userId),
      eq(outfits.userId, userId),
    ))
    .orderBy(collectionOutfits.position, collectionOutfits.addedAt)
    .all() as { outfitId: string }[]
  return rows.map(r => r.outfitId)
}

export function getCollectionIdsForOutfit(outfitId: string, userId: string): string[] {
  requireUserId(userId)
  const rows = db.select({ collectionId: collectionOutfits.collectionId })
    .from(collectionOutfits)
    .innerJoin(collections, eq(collections.id, collectionOutfits.collectionId))
    .innerJoin(outfits, eq(outfits.id, collectionOutfits.outfitId))
    .where(and(
      eq(collectionOutfits.outfitId, outfitId),
      eq(collections.userId, userId),
      eq(outfits.userId, userId),
    ))
    .all() as { collectionId: string }[]
  return rows.map(r => r.collectionId)
}

export function addOutfitsToCollection(collectionId: string, outfitIds: string[], userId: string): void {
  requireUserId(userId)
  db.transaction(tx => {
    if (!getCollection(collectionId, userId)) throw new Error('Collection not found')
    if (outfitIds.some(outfitId => !getOutfit(outfitId, userId))) throw new Error('Outfit not found')
    const now = Date.now()
    const existing = new Set(getOutfitIdsInCollection(collectionId, userId))
    const maxPos = existing.size
    outfitIds.forEach((outfitId, i) => {
      if (existing.has(outfitId)) return
      tx.insert(collectionOutfits).values({
        collectionId,
        outfitId,
        position: maxPos + i,
        addedAt: now,
      }).run()
      existing.add(outfitId)
    })
  })
}

export function removeOutfitFromCollection(collectionId: string, outfitId: string, userId: string): void {
  requireUserId(userId)
  db.delete(collectionOutfits)
    .where(and(
      eq(collectionOutfits.collectionId, collectionId),
      eq(collectionOutfits.outfitId, outfitId),
      inArray(collectionOutfits.collectionId,
        db.select({ id: collections.id }).from(collections).where(eq(collections.userId, userId))),
      inArray(collectionOutfits.outfitId,
        db.select({ id: outfits.id }).from(outfits).where(eq(outfits.userId, userId))),
    ))
    .run()
}

export function reorderOutfitsInCollection(collectionId: string, orderedIds: string[], userId: string): void {
  requireUserId(userId)
  orderedIds.forEach((outfitId, position) => {
    db.update(collectionOutfits)
      .set({ position })
      .where(and(
        eq(collectionOutfits.collectionId, collectionId),
        eq(collectionOutfits.outfitId, outfitId),
        inArray(collectionOutfits.collectionId,
          db.select({ id: collections.id }).from(collections).where(eq(collections.userId, userId))),
        inArray(collectionOutfits.outfitId,
          db.select({ id: outfits.id }).from(outfits).where(eq(outfits.userId, userId))),
      ))
      .run()
  })
}

// ─── Item Images ──────────────────────────────────────────────────────────────

export type ItemImage = typeof itemImages.$inferSelect
export type NewItemImage = typeof itemImages.$inferInsert

// Item-image helpers are scoped by the authenticated user, not by item/image id
// alone: an id guessed or leaked from another tenant must not resolve.
export function getItemImages(itemId: string, userId: string): ItemImage[] {
  requireUserId(userId)
  return db.select().from(itemImages)
    .where(and(eq(itemImages.itemId, itemId), eq(itemImages.userId, userId)))
    .orderBy(itemImages.position)
    .all() as ItemImage[]
}

export function getItemImageCounts(userId: string): { itemId: string; count: number }[] {
  return db.select({
    itemId: itemImages.itemId,
    count: sql<number>`count(*)`,
  }).from(itemImages)
    .where(eq(itemImages.userId, userId))
    .groupBy(itemImages.itemId)
    .all() as { itemId: string; count: number }[]
}

export function insertItemImage(data: Omit<NewItemImage, 'id' | 'createdAt'> & { userId: string }): ItemImage {
  requireUserId(data.userId)
  if (!getItem(data.itemId, data.userId)) throw new Error('Item not found')
  return db.insert(itemImages).values({
    id: nanoid(),
    ...data,
    createdAt: Date.now(),
  }).returning().get() as ItemImage
}

export function deleteItemImage(id: string, userId: string): void {
  requireUserId(userId)
  db.delete(itemImages).where(and(eq(itemImages.id, id), eq(itemImages.userId, userId))).run()
}

export function getItemImage(id: string, userId: string): ItemImage | undefined {
  requireUserId(userId)
  return db.select().from(itemImages)
    .where(and(eq(itemImages.id, id), eq(itemImages.userId, userId)))
    .get() as ItemImage | undefined
}

export function setItemImagePrimary(itemId: string, imageId: string, userId: string): void {
  requireUserId(userId)
  db.transaction(tx => {
    const target = tx.select().from(itemImages).where(and(
      eq(itemImages.id, imageId),
      eq(itemImages.itemId, itemId),
      eq(itemImages.userId, userId),
    )).get()
    if (!target) throw new Error('Item image not found')
    tx.update(itemImages).set({ isPrimary: 0 })
      .where(and(eq(itemImages.itemId, itemId), eq(itemImages.userId, userId))).run()
    tx.update(itemImages).set({ isPrimary: 1 })
      .where(and(eq(itemImages.id, imageId), eq(itemImages.userId, userId))).run()
  })
}

export function backfillItemImages(): void {
  const allItems = db.select({ id: items.id, imageUri: items.imageUri, userId: items.userId }).from(items).all() as { id: string; imageUri: string; userId: string }[]
  for (const item of allItems) {
    const existing = db.select().from(itemImages).where(eq(itemImages.itemId, item.id)).get()
    if (!existing) {
      db.insert(itemImages).values({
        id: nanoid(),
        userId: item.userId,
        itemId: item.id,
        imageUri: item.imageUri,
        role: 'crop',
        isPrimary: 1,
        position: 0,
        createdAt: Date.now(),
      }).run()
    }
  }
}

// ─── Personal API tokens (#321) ───────────────────────────────────────────────

export type ApiTokenScope = 'read' | 'write' | 'ai'

/** Row shape returned to clients — NEVER includes the hash or plaintext. */
export interface ApiTokenView {
  id: string
  name: string
  prefix: string
  scopes: ApiTokenScope[]
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

interface ApiTokenRow {
  id: string
  userId: string
  name: string
  tokenHash: string
  prefix: string
  scopes: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

const TOKEN_PREFIX = 'vst_'
// Plaintext body length: 24 url-safe chars (~144 bits of entropy) on top of
// the `vst_` label. Enough to be unguessable and unbruteforceable; short
// enough to paste into a config field.
const TOKEN_BODY_LEN = 24
const VALID_SCOPES: ApiTokenScope[] = ['read', 'write', 'ai']

function normalizeScopes(scopes: unknown): ApiTokenScope[] {
  if (!Array.isArray(scopes)) throw new Error('scopes must be an array')
  const seen = new Set<ApiTokenScope>()
  for (const s of scopes) {
    if (typeof s !== 'string') throw new Error('scopes must be strings')
    if (!VALID_SCOPES.includes(s as ApiTokenScope)) throw new Error(`invalid scope: ${s}`)
    seen.add(s as ApiTokenScope)
  }
  if (!seen.has('read')) seen.add('read') // read is always the default
  return VALID_SCOPES.filter(s => seen.has(s))
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

function genPlaintext(): string {
  // url-safe, no padding; 24 chars from 32 random bytes.
  return TOKEN_PREFIX + randomBytes(32).toString('base64url').slice(0, TOKEN_BODY_LEN)
}

function rowToView(row: ApiTokenRow): ApiTokenView {
  let scopes: ApiTokenScope[] = ['read']
  try { scopes = JSON.parse(row.scopes) as ApiTokenScope[] } catch { /* keep default */ }
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
}

/**
 * Mint a new personal API token. Returns the plaintext ONCE (the caller shows
 * it to the user and the server never persists it); the stored row carries
 * only the SHA-256 hash. `read` is always included.
 */
export function createApiToken(userId: string, name: string, scopes: unknown): { plaintext: string; token: ApiTokenView } {
  requireUserId(userId)
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('Token name is required')
  if (trimmed.length > 128) throw new Error('Token name too long')
  const normScopes = normalizeScopes(scopes)
  const plaintext = genPlaintext()
  const id = nanoid()
  const now = Date.now()
  const row: ApiTokenRow = {
    id,
    userId,
    name: trimmed,
    tokenHash: hashToken(plaintext),
    prefix: plaintext.slice(0, TOKEN_PREFIX.length + 6),
    scopes: JSON.stringify(normScopes),
    createdAt: now,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  }
  db.insert(apiTokens).values(row).run()
  return { plaintext, token: rowToView(row) }
}

/** Look up a token by its plaintext. Constant-time hash comparison guard. */
export function getApiTokenByPlaintext(plaintext: string): (ApiTokenRow & { scopesArr: ApiTokenScope[] }) | null {
  if (typeof plaintext !== 'string' || !plaintext.startsWith(TOKEN_PREFIX)) return null
  const computed = hashToken(plaintext)
  const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, computed)).get() as ApiTokenRow | undefined
  if (!row) return null
  // Constant-time guard: the unique-index lookup already matched, but assert
  // explicitly so a future code path that fetches rows without the WHERE can't
  // silently authenticate on a timing-shortened string compare.
  const a = Buffer.from(computed)
  const b = Buffer.from(row.tokenHash)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let scopesArr: ApiTokenScope[] = ['read']
  try { scopesArr = JSON.parse(row.scopes) as ApiTokenScope[] } catch { /* default */ }
  return { ...row, scopesArr }
}

/** Update lastUsedAt on a token (best-effort; called after a successful auth). */
export function touchApiToken(tokenId: string): void {
  db.update(apiTokens).set({ lastUsedAt: Date.now() }).where(eq(apiTokens.id, tokenId)).run()
}

/** List a user's tokens (newest first). Never returns the hash or plaintext. */
export function listApiTokens(userId: string): ApiTokenView[] {
  requireUserId(userId)
  const rows = db.select().from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))
    .all() as ApiTokenRow[]
  return rows.map(rowToView)
}

/** Revoke a token. Only the owning user may revoke. Returns whether a row was affected. */
export function revokeApiToken(userId: string, tokenId: string): boolean {
  requireUserId(userId)
  const result = db.update(apiTokens).set({ revokedAt: Date.now() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), sql`${apiTokens.revokedAt} IS NULL`))
    .run()
  return result.changes > 0
}
