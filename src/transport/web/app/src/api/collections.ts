import { apiFetch, apiFetchJSON } from './client'
import type { HydratedOutfit } from './outfits'

export interface Collection {
  id: string
  name: string
  description: string | null
  coverImageUri: string | null
  season: string      // JSON string
  tags: string        // JSON string
  createdAt: number
  updatedAt: number
}

/** List/detail shape without hydration — the server always attaches the count. */
export interface CollectionWithCount extends Collection {
  outfitCount: number
}

/** `?hydrate=true` shape — carries both the outfits and their count (#361). */
export interface HydratedCollection extends CollectionWithCount {
  outfits: HydratedOutfit[]
}

export async function fetchCollections(): Promise<CollectionWithCount[]> {
  return apiFetchJSON('/api/collections')
}

export async function fetchCollectionsHydrated(): Promise<HydratedCollection[]> {
  return apiFetchJSON('/api/collections?hydrate=true')
}

export async function fetchCollection(id: string): Promise<HydratedCollection> {
  return apiFetchJSON(`/api/collections/${id}?hydrate=true`)
}

export async function createCollection(data: {
  name: string
  description?: string
  season?: string[]
  tags?: string[]
}): Promise<Collection> {
  return apiFetchJSON('/api/collections', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateCollection(id: string, data: {
  name?: string
  description?: string | null
  season?: string[]
  tags?: string[]
}): Promise<Collection> {
  return apiFetchJSON(`/api/collections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function uploadCollectionCover(id: string, file: File): Promise<Collection> {
  const fd = new FormData()
  fd.append('image', file)
  return apiFetchJSON(`/api/collections/${id}/cover`, { method: 'POST', body: fd })
}

export async function removeCollectionCover(id: string): Promise<Collection> {
  return apiFetchJSON(`/api/collections/${id}/cover`, { method: 'DELETE' })
}

export async function addOutfitsToCollection(id: string, outfitIds: string[]): Promise<void> {
  await apiFetch(`/api/collections/${id}/outfits`, {
    method: 'POST',
    body: JSON.stringify({ outfitIds }),
  })
}

export async function removeOutfitFromCollection(id: string, outfitId: string): Promise<void> {
  await apiFetch(`/api/collections/${id}/outfits/${outfitId}`, { method: 'DELETE' })
}

export async function reorderOutfitsInCollection(id: string, orderedIds: string[]): Promise<void> {
  await apiFetch(`/api/collections/${id}/outfits/order`, {
    method: 'PATCH',
    body: JSON.stringify({ orderedIds }),
  })
}

export async function deleteCollection(id: string): Promise<void> {
  await apiFetch(`/api/collections/${id}`, { method: 'DELETE' })
}

export async function fetchCollectionsForOutfit(outfitId: string): Promise<string[]> {
  return apiFetchJSON(`/api/collections/for-outfit/${outfitId}`)
}
