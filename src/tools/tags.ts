import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { collections, items, outfits } from '../db/schema.js'
import { requireUserId } from '../db/queries.js'
import { normalizeTags } from '../lib/normalizeTags.js'

// #372 — the user's created tags and occasions as one list each, with how
// many items / outfits / collections use them, and deleting one everywhere.
// Removing a tag from a single card stays a normal PATCH on that card.
// Everything is scoped to the user; values are normalised (trim + lowercase).

export type FacetKind = 'tag' | 'occasion'

export interface FacetUsage {
  value: string
  items: number
  outfits: number
  collections: number
}

export interface FacetDeleteResult {
  items: number
  outfits: number
  collections: number
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? normalizeTags(parsed) : []
  } catch {
    return []
  }
}

function norm(value: string): string {
  return value.trim().toLowerCase()
}

/** Every tag (or occasion) the user has on anything, most used first. */
export function listFacetUsage(userId: string, kind: FacetKind): FacetUsage[] {
  requireUserId(userId)
  const usage = new Map<string, FacetUsage>()
  const bump = (value: string, field: 'items' | 'outfits' | 'collections') => {
    const v = norm(value)
    if (!v) return
    const row = usage.get(v) ?? { value: v, items: 0, outfits: 0, collections: 0 }
    row[field]++
    usage.set(v, row)
  }

  const itemRows = db.select({ tags: items.tags, occasion: items.occasion }).from(items).where(eq(items.userId, userId)).all()
  for (const r of itemRows) for (const v of parseList(kind === 'tag' ? r.tags : r.occasion)) bump(v, 'items')

  const outfitRows = db.select({ tags: outfits.tags, occasion: outfits.occasion }).from(outfits).where(eq(outfits.userId, userId)).all()
  for (const r of outfitRows) {
    if (kind === 'tag') for (const v of parseList(r.tags)) bump(v, 'outfits')
    else if (r.occasion) bump(r.occasion, 'outfits')
  }

  if (kind === 'tag') {
    const colRows = db.select({ tags: collections.tags }).from(collections).where(eq(collections.userId, userId)).all()
    for (const r of colRows) for (const v of parseList(r.tags)) bump(v, 'collections')
  }

  const total = (u: FacetUsage) => u.items + u.outfits + u.collections
  return [...usage.values()].sort((a, b) => total(b) - total(a) || a.value.localeCompare(b.value))
}

/**
 * Removes the values from every item, outfit and collection of this user, in
 * one transaction. Text vectors are not refreshed inline: every touched row
 * gets a new updated_at, and the embeddings reconciler re-embeds rows whose
 * vector is older than that (#376).
 */
export function deleteFacetEverywhere(userId: string, kind: FacetKind, values: string[]): FacetDeleteResult {
  requireUserId(userId)
  const drop = new Set(values.map(norm).filter(Boolean))
  const result: FacetDeleteResult = { items: 0, outfits: 0, collections: 0 }
  if (!drop.size) return result
  const now = Date.now()

  db.transaction(tx => {
    for (const r of tx.select({ id: items.id, tags: items.tags, occasion: items.occasion }).from(items).where(eq(items.userId, userId)).all()) {
      const list = parseList(kind === 'tag' ? r.tags : r.occasion)
      const kept = list.filter(v => !drop.has(v))
      if (kept.length === list.length) continue
      tx.update(items)
        .set(kind === 'tag' ? { tags: JSON.stringify(kept), updatedAt: now } : { occasion: JSON.stringify(kept), updatedAt: now })
        .where(and(eq(items.id, r.id), eq(items.userId, userId))).run()
      result.items++
    }

    for (const r of tx.select({ id: outfits.id, tags: outfits.tags, occasion: outfits.occasion }).from(outfits).where(eq(outfits.userId, userId)).all()) {
      if (kind === 'tag') {
        const list = parseList(r.tags)
        const kept = list.filter(v => !drop.has(v))
        if (kept.length === list.length) continue
        tx.update(outfits).set({ tags: JSON.stringify(kept), updatedAt: now }).where(and(eq(outfits.id, r.id), eq(outfits.userId, userId))).run()
      } else {
        if (!r.occasion || !drop.has(norm(r.occasion))) continue
        tx.update(outfits).set({ occasion: null, updatedAt: now }).where(and(eq(outfits.id, r.id), eq(outfits.userId, userId))).run()
      }
      result.outfits++
    }

    if (kind === 'tag') {
      for (const r of tx.select({ id: collections.id, tags: collections.tags }).from(collections).where(eq(collections.userId, userId)).all()) {
        const list = parseList(r.tags)
        const kept = list.filter(v => !drop.has(v))
        if (kept.length === list.length) continue
        tx.update(collections).set({ tags: JSON.stringify(kept), updatedAt: now })
          .where(and(eq(collections.id, r.id), eq(collections.userId, userId))).run()
        result.collections++
      }
    }
  })
  return result
}
