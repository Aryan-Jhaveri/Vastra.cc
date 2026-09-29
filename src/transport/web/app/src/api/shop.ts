import { apiFetch, apiFetchJSON } from './client'

/** apiFetch resolves on 4xx/5xx; mutations must throw so optimistic UI reverts. */
async function mutate(path: string, init: RequestInit): Promise<void> {
  const res = await apiFetch(path, init)
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} HTTP ${res.status}`)
}

export interface ShopProduct {
  id: string
  title: string
  imageUrl: string | null
  price: string | null
  merchant: string
  url: string | null
  available: boolean
}

/** Server-built shop search for a Suggest/Discover run (shortlist event `shop`). */
export interface ShopQuery {
  query: string
  intent?: string
}

export interface RelatedShopResult {
  products: ShopProduct[]
  nextCursor: string | null
  /** True when the server ordered `products` by Jev match, best first. */
  ranked?: boolean
  error?: string
}

/**
 * What the shop row is ranked against (#324): ids of the related items and
 * outfits on screen, and the AI recommendations. The server re-reads the ids
 * for the session user; no closet data is sent from here.
 */
export interface ShopRankContext {
  itemIds: string[]
  outfitIds: string[]
  recommendations: Array<{ name: string; occasion?: string; reasoning?: string; itemIds: string[] }>
}

/**
 * A liked product with live catalog data. Only the id is stored (Shopify's
 * policy forbids caching results), so `product` is fetched on every load:
 * `live` — current data; `gone` — no longer listed; `unknown` — lookup failed.
 */
export interface LikedProduct {
  productId: string
  savedItemId: string | null
  createdAt: number
  status: 'live' | 'gone' | 'unknown'
  product: ShopProduct | null
}

export interface LikedProductsPage {
  likes: LikedProduct[]
  total: number
  nextOffset: number | null
  error?: string
}

export async function fetchRelatedShop(shop: ShopQuery, cursor?: string, context?: ShopRankContext): Promise<RelatedShopResult> {
  return apiFetchJSON<RelatedShopResult>('/api/shop/related', {
    method: 'POST',
    body: JSON.stringify({ query: shop.query, intent: shop.intent, cursor, context }),
  })
}

export type ItemShopOutcome =
  | { kind: 'result'; products: ShopProduct[]; nextCursor: string | null }
  | { kind: 'capped'; resetsAt: number | null }
  | { kind: 'busy' }
  | { kind: 'error' }

/**
 * #332 — Related shop items for one closet item. The query is built on the
 * server from the item. Silent: a catalog 502 must not raise the global
 * server-down banner. The first page uses one Find related; More pages don't.
 */
export async function fetchShopForItem(itemId: string, cursor?: string): Promise<ItemShopOutcome> {
  let res: Response
  try {
    res = await apiFetch(`/api/shop/for-item/${encodeURIComponent(itemId)}`, {
      method: 'POST',
      body: JSON.stringify(cursor ? { cursor } : {}),
    }, { silent: true })
  } catch {
    return { kind: 'error' }
  }
  if (res.ok) {
    const body = await res.json() as { products: ShopProduct[]; nextCursor: string | null }
    return { kind: 'result', products: body.products, nextCursor: body.nextCursor }
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as { resetsAt?: number | null }
    return { kind: 'capped', resetsAt: body.resetsAt ?? null }
  }
  if (res.status === 409) return { kind: 'busy' }
  return { kind: 'error' }
}

export async function fetchLikedProducts(offset = 0): Promise<LikedProductsPage> {
  return apiFetchJSON<LikedProductsPage>(`/api/shop/likes?offset=${offset}`)
}

/** Every liked product id — for heart state; no catalog call. */
export async function fetchLikedProductIds(): Promise<string[]> {
  const { productIds } = await apiFetchJSON<{ productIds: string[] }>('/api/shop/likes/ids')
  return productIds
}

export async function likeProduct(productId: string): Promise<void> {
  await mutate(`/api/shop/likes/${encodeURIComponent(productId)}`, { method: 'PUT' })
}

export async function unlikeProduct(productId: string): Promise<void> {
  await mutate(`/api/shop/likes/${encodeURIComponent(productId)}`, { method: 'DELETE' })
}

export async function bulkUnlikeProducts(productIds: string[]): Promise<void> {
  await mutate('/api/shop/likes/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ productIds }),
  })
}
