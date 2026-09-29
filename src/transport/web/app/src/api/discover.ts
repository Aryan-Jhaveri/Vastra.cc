import { apiFetchJSON } from './client'
import type { OutfitSuggestion } from './outfits'

export interface DiscoverContext {
  description: string
  source: 'prompt' | 'image' | 'shared'
  retrievalMode?: 'generated' | 'retrieved'
}

export interface DiscoverResult {
  context: DiscoverContext
  suggestions: OutfitSuggestion[]
}

export async function findOutfitsFromPrompt(
  prompt: string,
  lat?: number,
  lon?: number,
): Promise<DiscoverResult> {
  return apiFetchJSON('/api/discover', {
    method: 'POST',
    body: JSON.stringify({ mode: 'prompt', prompt, lat, lon }),
  })
}

export async function findOutfitsFromImage(
  imageFile: File,
  lat?: number,
  lon?: number,
): Promise<DiscoverResult> {
  const form = new FormData()
  form.set('mode', 'image')
  form.set('image', imageFile)
  if (lat !== undefined) form.set('lat', String(lat))
  if (lon !== undefined) form.set('lon', String(lon))
  return apiFetchJSON('/api/discover', {
    method: 'POST',
    body: form,
  })
}

export async function findOutfitsFromShare(
  shareId: string,
  lat?: number,
  lon?: number,
): Promise<DiscoverResult> {
  return apiFetchJSON('/api/discover', {
    method: 'POST',
    body: JSON.stringify({ mode: 'shared', shareId, lat, lon }),
  })
}
