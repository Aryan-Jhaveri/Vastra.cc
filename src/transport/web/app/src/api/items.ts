import { apiFetch, apiFetchJSON } from './client'
import { apiFetchJSONRateAware } from '../lib/rateLimitRetry'

export interface Item {
  id: string
  imageUri: string
  category: string
  subcategory: string | null
  primaryColor: string | null
  colors: string        // JSON string — parse client-side as needed
  material: string | null
  materialSource: 'ocr' | 'manual' | null
  careInstructions: string
  brand: string | null
  size: string | null
  season: string
  tags: string
  aiDescription: string | null
  wearContext: string | null
  occasion: string
  timesWorn: number
  lastWornAt: number | null
  createdAt: number
  tagImageUri: string | null
}

export interface ItemClassification {
  category: string
  subcategory: string
  primary_color: string
  colors: string[]
  material: string
  season: string[]
  ai_description: string
  suggested_tags: string[]
  wear_context?: string | null
}

export interface ItemsPage {
  items: Item[]
  total: number
  page: number
  pageSize: number
}

export interface TagData {
  brand: string | null
  size: string | null
  material_composition: string | null
  care_instructions: string[]
  country_of_origin: string | null
}

export async function fetchItems(params: {
  categories?: string[]
  color?: string
  season?: string
  occasion?: string
  brand?: string
  type?: string
  material?: string
  tags?: string[]
  page?: number
  limit?: number
  cards?: boolean
} = {}): Promise<ItemsPage> {
  const qs = new URLSearchParams()
  if (params.categories?.length) params.categories.forEach(c => qs.append('category', c))
  if (params.color) qs.set('color', params.color)
  if (params.season) qs.set('season', params.season)
  if (params.occasion) qs.set('occasion', params.occasion)
  if (params.brand) qs.set('brand', params.brand)
  if (params.type) qs.set('type', params.type)
  if (params.material) qs.set('material', params.material)
  if (params.tags?.length) qs.set('tags', params.tags.join(','))
  if (params.page) qs.set('page', String(params.page))
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.cards) qs.set('cards', 'true')
  return apiFetchJSON(`/api/items?${qs}`)
}

export async function fetchItemMeta(): Promise<{ categories: string[] }> {
  return apiFetchJSON('/api/items/meta')
}

export async function fetchItem(id: string): Promise<Item> {
  return apiFetchJSON(`/api/items/${id}`)
}

export async function analyzeItem(file: File): Promise<ItemClassification> {
  const fd = new FormData()
  fd.append('image', file)
  // Rate-aware: a 429 throws RateLimitedError with the server's Retry-After so
  // the bulk flow can pace itself instead of failing the box.
  return apiFetchJSONRateAware('/api/items/analyze', { method: 'POST', body: fd })
}

/**
 * `idempotencyKey`: pass the same key when retrying one logical item, so a
 * retry after a lost response returns the item the server already saved
 * instead of creating a duplicate (#347).
 */
export async function createItem(file: File, fields: Record<string, unknown>, opts: { idempotencyKey?: string } = {}): Promise<Item> {
  const fd = new FormData()
  fd.append('image', file)
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) {
      fd.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v))
    }
  }
  return apiFetchJSONRateAware('/api/items', {
    method: 'POST',
    body: fd,
    ...(opts.idempotencyKey ? { headers: { 'Idempotency-Key': opts.idempotencyKey } } : {}),
  })
}

export async function updateItem(id: string, data: Partial<Item>): Promise<Item> {
  return apiFetchJSON(`/api/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteItem(id: string): Promise<void> {
  await apiFetch(`/api/items/${id}`, { method: 'DELETE' })
}

export async function markWorn(id: string): Promise<Item> {
  return apiFetchJSON(`/api/items/${id}/worn`, { method: 'POST' })
}

export async function replaceItemImage(id: string, file: File): Promise<Item> {
  const fd = new FormData()
  fd.append('image', file)
  return apiFetchJSON(`/api/items/${id}/image`, { method: 'POST', body: fd })
}

export async function scanTag(id: string, file: File): Promise<{ item: Item; tagData: TagData }> {
  const fd = new FormData()
  fd.append('image', file)
  return apiFetchJSON(`/api/items/${id}/tag`, { method: 'POST', body: fd })
}

// ─── Item Images ──────────────────────────────────────────────────────────────

export interface ItemImage {
  id: string
  itemId: string
  imageUri: string
  role: 'crop' | 'source' | 'reference' | 'generated' | null
  view: string | null
  position: number
  isPrimary: number
  createdAt: number
}

export async function fetchItemImages(itemId: string): Promise<ItemImage[]> {
  return apiFetchJSON(`/api/items/${itemId}/images`)
}

export async function uploadItemImage(itemId: string, file: File, view?: string): Promise<ItemImage> {
  const fd = new FormData()
  fd.append('image', file)
  if (view) fd.append('view', view)
  return apiFetchJSON(`/api/items/${itemId}/images`, { method: 'POST', body: fd })
}

export async function deleteItemImage(itemId: string, imageId: string): Promise<void> {
  await apiFetch(`/api/items/${itemId}/images/${imageId}`, { method: 'DELETE' })
}

export async function setItemImagePrimary(itemId: string, imageId: string): Promise<ItemImage> {
  return apiFetchJSON(`/api/items/${itemId}/images/${imageId}/primary`, { method: 'PATCH' })
}

export async function generateThumbnail(
  itemId: string,
  opts: { instruction?: string; sourceImageIds?: string[] } = {},
): Promise<{ image: ItemImage; imageUri: string }> {
  return apiFetchJSON(`/api/items/${itemId}/thumbnail`, {
    method: 'POST',
    body: JSON.stringify(opts),
  })
}
