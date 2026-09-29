import { apiFetch, apiFetchJSON } from './client'
import type { Item } from './items'

export interface Outfit {
  id: string
  name: string
  itemIds: string     // JSON string
  occasion: string | null
  season: string      // JSON string
  tags: string        // JSON string
  aiGenerated: number
  weatherContext: string | null
  notes: string | null
  coverImageUri: string | null
  timesWorn: number
  lastWornAt: number | null
  createdAt: number
}

export interface HydratedOutfit extends Outfit {
  items: Item[]
}

export interface OutfitSuggestion {
  item_ids: string[]
  name: string
  occasion: string
  reasoning: string
  items: Item[]
}

export interface WeatherData {
  temperature: number
  weatherCode: number
  condition: string
  precipitation: number
  windSpeed: number
  icon: string
}

export async function fetchOutfits(): Promise<Outfit[]> {
  return apiFetchJSON('/api/outfits')
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherData> {
  return apiFetchJSON(`/api/weather?lat=${lat}&lon=${lon}`)
}

export async function createOutfit(data: {
  name: string
  itemIds: string[]
  occasion?: string
  season?: string[]
  tags?: string[]
  notes?: string
  aiGenerated?: boolean
  weatherContext?: Record<string, unknown>
}): Promise<Outfit> {
  return apiFetchJSON('/api/outfits', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateOutfit(id: string, data: { name?: string; occasion?: string; season?: string[]; tags?: string[]; notes?: string; itemIds?: string[] }): Promise<Outfit> {
  return apiFetchJSON(`/api/outfits/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function updateOutfitItems(id: string, itemIds: string[]): Promise<Outfit> {
  return apiFetchJSON(`/api/outfits/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ itemIds }),
  })
}

export async function uploadOutfitCover(id: string, file: File): Promise<Outfit> {
  const fd = new FormData()
  fd.append('image', file)
  return apiFetchJSON(`/api/outfits/${id}/cover`, { method: 'POST', body: fd })
}

export async function removeOutfitCover(id: string): Promise<Outfit> {
  return apiFetchJSON(`/api/outfits/${id}/cover`, { method: 'DELETE' })
}

export async function fetchOutfitsHydrated(): Promise<HydratedOutfit[]> {
  return apiFetchJSON('/api/outfits?hydrate=true')
}

export async function deleteOutfit(id: string): Promise<void> {
  await apiFetch(`/api/outfits/${id}`, { method: 'DELETE' })
}

export async function markOutfitWorn(id: string): Promise<Outfit> {
  return apiFetchJSON(`/api/outfits/${id}/worn`, { method: 'POST' })
}

/** One outfit with its items (Ask tab "View"). */
export async function fetchOutfit(id: string): Promise<HydratedOutfit> {
  return apiFetchJSON(`/api/outfits/${encodeURIComponent(id)}`)
}
