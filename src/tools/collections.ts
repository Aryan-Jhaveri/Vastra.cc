import * as queries from '../db/queries.js'
import type { Collection, CreateCollectionInput, UpdateCollectionInput } from '../types/index.js'

export async function createCollection(input: CreateCollectionInput, userId: string): Promise<Collection> {
  return queries.insertCollection({
    userId,
    name: input.name,
    description: input.description ?? null,
    season: JSON.stringify(input.season ?? []),
    tags: JSON.stringify(input.tags ?? []),
    coverImageUri: null,
  })
}

export async function listCollections(userId: string): Promise<Collection[]> {
  return queries.getAllCollections(userId)
}

export async function getCollection(id: string, userId: string): Promise<Collection | null> {
  return queries.getCollection(id, userId) ?? null
}

export async function updateCollection(id: string, input: UpdateCollectionInput, userId: string): Promise<Collection> {
  const { season, tags, ...rest } = input
  const dbData: Record<string, unknown> = { ...rest }
  if (season !== undefined) dbData.season = JSON.stringify(season)
  if (tags !== undefined) dbData.tags = JSON.stringify(tags)
  const updated = queries.updateCollection(id, userId, dbData as Parameters<typeof queries.updateCollection>[2])
  if (!updated) throw new Error(`Collection ${id} not found`)
  return updated
}

export async function deleteCollection(id: string, userId: string): Promise<void> {
  queries.deleteCollection(id, userId)
}

export async function addOutfitsToCollection(collectionId: string, outfitIds: string[], userId: string): Promise<void> {
  queries.addOutfitsToCollection(collectionId, outfitIds, userId)
}

export async function removeOutfitFromCollection(collectionId: string, outfitId: string, userId: string): Promise<void> {
  queries.removeOutfitFromCollection(collectionId, outfitId, userId)
}

export async function reorderOutfitsInCollection(collectionId: string, orderedIds: string[], userId: string): Promise<void> {
  queries.reorderOutfitsInCollection(collectionId, orderedIds, userId)
}

export async function getOutfitIdsInCollection(collectionId: string, userId: string): Promise<string[]> {
  return queries.getOutfitIdsInCollection(collectionId, userId)
}

export async function getCollectionIdsForOutfit(outfitId: string, userId: string): Promise<string[]> {
  return queries.getCollectionIdsForOutfit(outfitId, userId)
}
