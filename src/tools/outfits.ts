import * as queries from '../db/queries.js'
import { normalizeTags } from '../lib/normalizeTags.js'
import type { Outfit, CreateOutfitInput, UpdateOutfitInput } from '../types/index.js'

function normalizeOccasionString(occasion: unknown): string | undefined {
  if (typeof occasion !== 'string') return undefined
  const trimmed = occasion.trim().toLowerCase()
  return trimmed || undefined
}

export class OutfitItemOwnershipError extends Error {
  constructor(public readonly itemIds: string[]) {
    super(`Unknown item ids: ${itemIds.join(', ')}`)
    this.name = 'OutfitItemOwnershipError'
  }
}

// Every item referenced by an outfit must belong to the outfit's owner.
function assertOwnedItems(itemIds: string[], userId: string): void {
  const owned = queries.getOwnedItemIds(itemIds, userId)
  const foreign = itemIds.filter(id => !owned.has(id))
  if (foreign.length) throw new OutfitItemOwnershipError(foreign)
}

export async function createOutfit(input: CreateOutfitInput, userId: string): Promise<Outfit> {
  assertOwnedItems(input.itemIds, userId)
  return queries.insertOutfit({
    userId,
    name: input.name,
    itemIds: JSON.stringify(input.itemIds),
    occasion: normalizeOccasionString(input.occasion),
    season: JSON.stringify(input.season ?? []),
    tags: JSON.stringify(normalizeTags(input.tags ?? [])),
    aiGenerated: input.aiGenerated ? 1 : 0,
    weatherContext: input.weatherContext ? JSON.stringify(input.weatherContext) : undefined,
    notes: input.notes,
    timesWorn: 0,
  })
}

export async function listOutfits(input: { occasion?: string; season?: string }, userId: string): Promise<Outfit[]> {
  const all = queries.getAllOutfits(userId)
  return all.filter(o => {
    if (input.occasion && o.occasion !== input.occasion) return false
    if (input.season && !o.season?.includes(input.season)) return false
    return true
  })
}

export async function getOutfit(id: string, userId: string): Promise<Outfit | null> {
  return queries.getOutfit(id, userId) ?? null
}

export async function getOutfitWithItems(id: string, userId: string) {
  return queries.getOutfitWithItems(id, userId)
}

export async function deleteOutfit(id: string, userId: string): Promise<void> {
  queries.deleteOutfit(id, userId)
}

export async function updateOutfit(id: string, input: UpdateOutfitInput, userId: string): Promise<Outfit> {
  const { season, tags, itemIds, occasion, ...rest } = input
  const dbData: Record<string, unknown> = { ...rest }
  if (season !== undefined) dbData.season = JSON.stringify(season)
  if (tags !== undefined) dbData.tags = JSON.stringify(normalizeTags(tags))
  if (itemIds !== undefined) {
    assertOwnedItems(itemIds, userId)
    dbData.itemIds = JSON.stringify(itemIds)
  }
  if (occasion !== undefined) dbData.occasion = normalizeOccasionString(occasion) ?? null
  const updated = queries.updateOutfit(id, userId, dbData as Parameters<typeof queries.updateOutfit>[2])
  if (!updated) throw new Error(`Outfit ${id} not found`)
  return updated
}

export async function markOutfitWorn(id: string, userId: string): Promise<Outfit> {
  const updated = queries.markOutfitWorn(id, userId)
  if (!updated) throw new Error(`Outfit ${id} not found`)
  return updated
}
