import { platformProfileUrl } from '../ucp/profile.js'
import { isShopifyCdnHost, readBodyCapped, BodyTooLargeError } from './cdn.js'

/**
 * Shopify Global Catalog MCP client (#324).
 *
 * Calls `https://catalog.shopify.com/api/ucp/mcp` with `tools/call` for
 * `search_catalog` and `lookup_catalog`. No registration, signature or key
 * needed. The profile URL points at our `/.well-known/ucp` so Shopify can
 * verify we're a real platform; Shopify must be able to fetch it, so from dev
 * set UCP_PROFILE_URL to a public host.
 *
 * Request shape follows https://shopify.dev/docs/agents/catalog/global-catalog:
 * a JSON-RPC 2.0 envelope with the profile at
 * `params.arguments.meta['ucp-agent'].profile`. Anywhere else (top-level
 * `meta`, MCP's `params._meta`) Shopify answers 422 `invalid_profile_url` /
 * "Missing profile uri". The `UCP-Agent` header is also sent, matching the
 * per-store client in ../ucp/client.ts.
 *
 * Usage policy (https://shopify.dev/docs/agents/catalog):
 *   - "Caching results isn't allowed" — every call here is live; callers must
 *     not cache results either. Liked items store only product ids and are
 *     re-read with lookup_catalog.
 *   - Images "must be rendered in real-time (not downloaded to servers)" —
 *     image URLs are only ever handed to the browser, never fetched here.
 *
 * Privacy contract (issue #324 § "Privacy / hosting"):
 *   - Outbound data is ONLY the shop query, an optional intent sentence
 *     (which may include current weather), a country code, the user's
 *     opt-in "shop for" gender filter, product ids the user liked, and —
 *     from Ask's search_shop only, when the user asks — a currency, price
 *     range / tier and clothing sizes. None of it is tied to a user identifier.
 *   - No user id, email, photos or closet contents.
 *   - Product text we get BACK (title, description, colours, features) is
 *     passed to Jev for ranking (src/ai/shopRank.ts, ZDR, not stored) and is
 *     never cached — ranking happens per live request.
 *   - The query/intent come from ./shopQuery.ts: the user's typed prompt,
 *     garment words derived from the weather + chosen occasion, or — in
 *     Discover image mode — the AI's garment hints and vibe for an inspiration
 *     photo the user uploaded. The photo itself is never sent, so the privacy
 *     page needs a line saying these descriptions go to Shopify's catalog.
 */

const GLOBAL_CATALOG_URL = 'https://catalog.shopify.com/api/ucp/mcp'
const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** lookup_catalog accepts 1–50 ids per call. */
export const LOOKUP_MAX_IDS = 50

/**
 * Shopify Standard Product Taxonomy categories a closet can hold. The filter
 * takes category GID strings (OR logic) — the published schema's shape; the
 * docs page's `{ id, taxonomy }` example is rejected by the live API.
 * `aa` (all Apparel & Accessories) is deliberately not used: it includes wigs,
 * costumes and handbag accessories.
 */
export const APPAREL_CATEGORY_GIDS = [
  'gid://shopify/TaxonomyCategory/aa-1', // Clothing
  'gid://shopify/TaxonomyCategory/aa-2', // Clothing Accessories
  'gid://shopify/TaxonomyCategory/aa-5', // Handbags, Wallets & Cases
  'gid://shopify/TaxonomyCategory/aa-6', // Jewelry
  'gid://shopify/TaxonomyCategory/aa-8', // Shoes
] as const

/** Shopify taxonomy "Target gender" values (gid://shopify/TaxonomyValue/18–20).
 *  Exact strings: the live API silently returns nothing for e.g. "Women". */
export type CatalogGender = 'female' | 'male'
const TARGET_GENDER: Record<CatalogGender, string> = { female: 'Female', male: 'Male' }

/** Normalized card shape for the frontend ProductCard. */
export interface ShopProduct {
  id: string
  title: string
  imageUrl: string | null
  price: string | null
  merchant: string
  url: string | null
  available: boolean
}

export interface CatalogSearchResult {
  products: ShopProduct[]
  nextCursor: string | null
  /**
   * Text details per product id for Jev ranking (src/ai/shopRank.ts). Server
   * side only — never sent to the browser, never stored.
   */
  details: Record<string, ProductDecisionDetails>
}

/** Product text Jev scores against the closet context. All fields capped. */
export interface ProductDecisionDetails {
  title: string
  colors?: string[]
  description?: string
  features?: string[]
}

export interface CatalogLookupResult {
  products: ShopProduct[]
  /** Ids Shopify reported as not found (delisted / removed products). */
  notFound: string[]
}

interface McpRequest {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: {
    name: 'search_catalog' | 'lookup_catalog'
    arguments: Record<string, unknown>
  }
}

interface CatalogVariant {
  url?: string
  availability?: { available?: boolean }
  seller?: { name?: string; url?: string }
}

interface CatalogProduct {
  id?: string
  title?: string
  /** `plain` is the merchant description as plain text (untrusted). */
  description?: { plain?: string; html?: string }
  options?: Array<{ name?: string; values?: Array<{ label?: string }> }>
  metadata?: { top_features?: unknown; unique_selling_points?: unknown }
  url?: string
  media?: Array<{ type?: string; url?: string }>
  price_range?: { min?: { amount: number; currency: string } }
  variants?: CatalogVariant[]
}

interface McpStructuredContent {
  products?: CatalogProduct[]
  pagination?: { cursor?: string; has_next_page?: boolean }
  messages?: Array<{ type?: string; code?: string; content?: string }>
}

interface McpResponse {
  result?: {
    structuredContent?: McpStructuredContent
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  error?: { code: number; message: string }
}

/**
 * Resize a Shopify CDN image URL to width=400. Originals can be ~6MB (#323).
 * Only applies to Shopify CDN hosts; other URLs pass through unchanged. This
 * only rewrites the URL the browser loads — the image is never fetched here.
 */
export function resizeShopifyImage(url: string): string {
  try {
    const u = new URL(url)
    if (isShopifyCdnHost(u.hostname)) {
      u.searchParams.set('width', '400')
      return u.toString()
    }
  } catch {
    // Not a URL — pass through
  }
  return url
}

function httpsOrNull(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).protocol === 'https:' ? url : null } catch { return null }
}

const DETAIL_DESCRIPTION_MAX = 240
const DETAIL_FEATURE_MAX = 120
const DETAIL_MAX_FEATURES = 3
const DETAIL_MAX_COLORS = 6

function capDetail(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Text details for Jev ranking: title, colour option labels, the plain-text
 * description and the first few feature bullets. Merchant text is untrusted
 * (#323), so everything is capped; Jev only returns a probability per product,
 * so injected text can at most skew a score. Vendor `tags` are never used.
 */
export function productDecisionDetails(p: CatalogProduct): ProductDecisionDetails {
  const colors = (p.options ?? [])
    .find(o => o.name?.toLowerCase() === 'color' || o.name?.toLowerCase() === 'colour')
    ?.values?.map(v => v.label).filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
    .slice(0, DETAIL_MAX_COLORS)
    .map(l => capDetail(l, 40))
  const rawFeatures = p.metadata?.top_features ?? p.metadata?.unique_selling_points
  const features = Array.isArray(rawFeatures)
    ? rawFeatures.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .slice(0, DETAIL_MAX_FEATURES).map(f => capDetail(f, DETAIL_FEATURE_MAX))
    : []
  const plain = typeof p.description?.plain === 'string' ? p.description.plain : ''
  const details: ProductDecisionDetails = { title: capDetail(p.title ?? 'Untitled', 200) }
  if (colors?.length) details.colors = colors
  if (plain.trim()) details.description = capDetail(plain, DETAIL_DESCRIPTION_MAX)
  if (features.length) details.features = features
  return details
}

/** Normalize a Global Catalog product into a ShopProduct card. */
export function normalizeCatalogProduct(p: CatalogProduct): ShopProduct {
  const image = p.media?.find(m => (m.type ?? 'image') === 'image' && m.url)
  const min = p.price_range?.min
  const variants = p.variants ?? []
  const merchant = variants.find(v => v.seller?.name)?.seller?.name ?? 'Shopify store'
  // The product page link lives on the variant; `product.url` is absent in
  // live search and lookup responses.
  const url = httpsOrNull(p.url) ?? httpsOrNull(variants.find(v => v.url)?.url)
  return {
    id: p.id ?? '',
    title: p.title ?? 'Untitled',
    imageUrl: image?.url ? resizeShopifyImage(image.url) : null,
    price: min ? `${(min.amount / 100).toFixed(2)} ${min.currency}` : null,
    merchant,
    url,
    available: variants.length === 0 || variants.some(v => v.availability?.available !== false),
  }
}

function envelope(name: McpRequest['params']['name'], catalog: Record<string, unknown>): McpRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name,
      // Shopify reads the profile from `arguments.meta`, not MCP's `params._meta`.
      arguments: {
        meta: { 'ucp-agent': { profile: platformProfileUrl() } },
        catalog,
      },
    },
  }
}

function buyerContext(country: string | undefined, intent?: string, currency?: string): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {}
  if (country) context.address_country = country
  if (currency) context.currency = currency
  if (intent) context.intent = intent
  return Object.keys(context).length ? context : undefined
}

export type PriceTier = 'low' | 'medium' | 'high'

export interface CatalogSearchOptions {
  query: string
  intent?: string
  country?: string
  gender?: CatalogGender
  /** ISO 4217. Prices are in this currency's minor units. */
  currency?: string
  minPriceMinor?: number
  maxPriceMinor?: number
  /** Price relative to the product's category ("budget"). */
  priceTiers?: PriceTier[]
  sizes?: string[]
  limit?: number
  cursor?: string
}

/**
 * Build the search request. Sends only the shop query, optional intent,
 * country, currency, price/size filters and pagination — never userId, email,
 * photos or closet contents. Results are limited to apparel categories and,
 * when the country is known, to products that ship there.
 */
export function buildMcpSearchRequest(opts: CatalogSearchOptions): McpRequest {
  const catalog: Record<string, unknown> = { query: opts.query }
  const context = buyerContext(opts.country, opts.intent, opts.currency)
  if (context) catalog.context = context
  const filters: Record<string, unknown> = { categories: [...APPAREL_CATEGORY_GIDS] }
  if (opts.country) filters.ships_to = { country: opts.country }
  if (opts.minPriceMinor !== undefined || opts.maxPriceMinor !== undefined) {
    filters.price = {
      ...(opts.minPriceMinor !== undefined ? { min: opts.minPriceMinor } : {}),
      ...(opts.maxPriceMinor !== undefined ? { max: opts.maxPriceMinor } : {}),
    }
  }
  if (opts.priceTiers?.length) filters.price_tier = [...opts.priceTiers]
  // AND between attribute entries, OR within one.
  const attributes: Array<{ name: string; values: string[] }> = []
  // Unisex is always included so gender-neutral items aren't filtered out.
  if (opts.gender) attributes.push({ name: 'Target gender', values: [TARGET_GENDER[opts.gender], 'Unisex'] })
  if (opts.sizes?.length) attributes.push({ name: 'Size', values: [...opts.sizes] })
  if (attributes.length) filters.attributes = attributes
  catalog.filters = filters
  const pagination: Record<string, unknown> = { limit: opts.limit ?? 10 }
  if (opts.cursor) pagination.cursor = opts.cursor
  catalog.pagination = pagination
  return envelope('search_catalog', catalog)
}

/** Build a lookup request for liked product ids (1–50). */
export function buildMcpLookupRequest(opts: { ids: string[]; country?: string }): McpRequest {
  if (opts.ids.length === 0 || opts.ids.length > LOOKUP_MAX_IDS) {
    throw new Error(`lookup_catalog takes 1–${LOOKUP_MAX_IDS} ids`)
  }
  const catalog: Record<string, unknown> = { ids: opts.ids }
  const context = buyerContext(opts.country)
  if (context) catalog.context = context
  return envelope('lookup_catalog', catalog)
}

async function callCatalog(req: McpRequest, fetchImpl: typeof fetch): Promise<McpStructuredContent> {
  const res = await fetchImpl(GLOBAL_CATALOG_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'ucp-agent': `profile="${platformProfileUrl()}"`,
    },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Shopify Global Catalog HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  let text: string
  try {
    text = (await readBodyCapped(res, MAX_BODY_BYTES)).toString('utf8')
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new Error('Shopify Global Catalog response too large')
    throw err
  }

  let json: McpResponse
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Shopify Global Catalog returned non-JSON response')
  }

  if (json.error) {
    throw new Error(`Shopify Global Catalog MCP error ${json.error.code}: ${json.error.message}`)
  }

  const textContent = json.result?.content?.find(c => c.type === 'text' && c.text)?.text
  // A tool-level failure (e.g. "Invalid arguments: …") arrives as a 200 with
  // isError — surface it instead of reading it as "no results".
  if (json.result?.isError) {
    throw new Error(`Shopify Global Catalog tool error: ${(textContent ?? 'unknown').slice(0, 300)}`)
  }

  if (json.result?.structuredContent) return json.result.structuredContent
  // Some responses carry the payload as JSON text instead.
  if (textContent) {
    try { return JSON.parse(textContent) as McpStructuredContent } catch { /* fall through */ }
  }
  return {}
}

/**
 * Search the Shopify Global Catalog. Returns normalized ShopProduct cards.
 * Throws on HTTP, transport, MCP or tool errors. Caller should catch and
 * return [] (never break the page on a catalog error).
 */
export async function searchGlobalCatalog(
  opts: CatalogSearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogSearchResult> {
  const structured = await callCatalog(buildMcpSearchRequest(opts), fetchImpl)
  const raw = structured.products ?? []
  const details: Record<string, ProductDecisionDetails> = {}
  for (const p of raw) if (p.id) details[p.id] = productDecisionDetails(p)
  return {
    products: raw.map(normalizeCatalogProduct),
    nextCursor: structured.pagination?.has_next_page ? (structured.pagination.cursor ?? null) : null,
    details,
  }
}

/**
 * Look up products by id — used to show liked items with live data instead
 * of a stored snapshot. Products Shopify no longer lists come back in
 * `notFound`.
 */
export async function lookupGlobalCatalog(
  opts: { ids: string[]; country?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogLookupResult> {
  const structured = await callCatalog(buildMcpLookupRequest(opts), fetchImpl)
  const notFound = (structured.messages ?? [])
    .filter(m => m.code === 'not_found' && typeof m.content === 'string')
    .map(m => m.content as string)
  return {
    products: (structured.products ?? []).map(normalizeCatalogProduct),
    notFound,
  }
}
