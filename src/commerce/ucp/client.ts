import { randomUUID } from 'crypto'
import { signRequest, type SigningKey } from './signing.js'
import { CAP_CATALOG_SEARCH } from './profile.js'

/**
 * Minimal UCP platform client — business discovery + catalog search (#323).
 * Spike scope: no cart, checkout or order calls yet.
 */

const TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 2 * 1024 * 1024

export class UcpError extends Error {
  constructor(
    readonly code: 'bad_origin' | 'no_profile' | 'no_rest_service' | 'no_catalog_search' | 'http' | 'bad_response',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UcpError'
  }
}

export interface UcpBusiness {
  origin: string
  endpoint: string
  version: string
  capabilities: string[]
}

type FetchLike = typeof fetch

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length > MAX_BODY_BYTES) throw new UcpError('bad_response', 'Response too large')
  try {
    return JSON.parse(text)
  } catch {
    throw new UcpError('bad_response', `Non-JSON response: ${text.slice(0, 200)}`)
  }
}

/** Accepts `https://store.example` or `store.example`; rejects non-https (localhost excepted). */
export function normalizeOrigin(input: string): string {
  let url: URL
  try {
    url = new URL(input.includes('://') ? input : `https://${input}`)
  } catch {
    throw new UcpError('bad_origin', `Not a valid origin: ${input}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UcpError('bad_origin', `Origin must be https: ${input}`)
  }
  return url.origin
}

/** Fetch a business's /.well-known/ucp and pick its REST shopping endpoint. */
export async function discoverBusiness(originInput: string, fetchImpl: FetchLike = fetch): Promise<UcpBusiness> {
  const origin = normalizeOrigin(originInput)
  const res = await fetchImpl(`${origin}/.well-known/ucp`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new UcpError('no_profile', `${origin}/.well-known/ucp returned ${res.status}`, res.status)

  const profile = await readJson(res) as {
    ucp?: {
      version?: string
      services?: Record<string, Array<{ transport?: string; endpoint?: string; version?: string }>>
      capabilities?: Record<string, unknown>
    }
  }
  const rest = profile.ucp?.services?.['dev.ucp.shopping']?.find(s => s.transport === 'rest' && s.endpoint)
  if (!rest?.endpoint) throw new UcpError('no_rest_service', `${origin} has no REST dev.ucp.shopping service`)

  const capabilities = Object.keys(profile.ucp?.capabilities ?? {})
  if (!capabilities.includes(CAP_CATALOG_SEARCH)) {
    throw new UcpError('no_catalog_search', `${origin} does not advertise ${CAP_CATALOG_SEARCH}`)
  }
  return {
    origin,
    endpoint: rest.endpoint.replace(/\/+$/, ''),
    version: rest.version ?? profile.ucp?.version ?? 'unknown',
    capabilities,
  }
}

export interface SearchOptions {
  query: string
  /** Business category values (OR). */
  categories?: string[]
  /** Max price in ISO 4217 minor units. */
  maxPriceMinor?: number
  /** ISO 3166-1 alpha-2 — the only buyer context we send. */
  country?: string
  limit?: number
  cursor?: string
}

/**
 * Build the outbound search body from an explicit allowlist. Nothing about the
 * user (ids, email, photos, closet contents) can reach a merchant through here.
 */
export function buildSearchRequest(opts: SearchOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { query: opts.query }
  if (opts.country) body.context = { address_country: opts.country }
  const filters: Record<string, unknown> = {}
  if (opts.categories?.length) filters.categories = opts.categories
  if (opts.maxPriceMinor !== undefined) filters.price = { max: opts.maxPriceMinor }
  if (Object.keys(filters).length) body.filters = filters
  const pagination: Record<string, unknown> = {}
  if (opts.limit !== undefined) pagination.limit = opts.limit
  if (opts.cursor) pagination.cursor = opts.cursor
  if (Object.keys(pagination).length) body.pagination = pagination
  return body
}

/** What Vastra shows on a product card. */
export interface VastraProduct {
  id: string
  title: string
  url?: string
  imageUrl?: string
  price?: { amountMinor: number; currency: string }
  merchant: string
  categories: string[]
  available: boolean
}

interface UcpProduct {
  id: string
  title: string
  url?: string
  media?: Array<{ type?: string; url?: string }>
  price_range?: { min?: { amount: number; currency: string } }
  categories?: Array<{ value: string; taxonomy?: string }>
  variants?: Array<{ availability?: { available?: boolean }; seller?: { name?: string } }>
}

export function normalizeProduct(p: UcpProduct, business: Pick<UcpBusiness, 'origin'>): VastraProduct {
  const image = p.media?.find(m => (m.type ?? 'image') === 'image' && m.url)
  const min = p.price_range?.min
  return {
    id: p.id,
    title: p.title,
    url: p.url,
    imageUrl: image?.url,
    price: min ? { amountMinor: min.amount, currency: min.currency } : undefined,
    merchant: p.variants?.find(v => v.seller?.name)?.seller?.name ?? new URL(business.origin).hostname,
    categories: (p.categories ?? []).map(c => c.value),
    available: (p.variants ?? []).some(v => v.availability?.available !== false),
  }
}

export interface SearchResult {
  status: number
  products: VastraProduct[]
  /** Business-reported errors/warnings (HTTP 200 with messages[]). */
  messages: unknown[]
  nextCursor?: string
  negotiated: string[]
}

export interface SearchClientOptions {
  profileUrl: string
  /** Omit to send an unsigned request (spike: tests what anonymous access gets). */
  signingKey?: SigningKey | null
  fetchImpl?: FetchLike
}

export async function searchCatalog(
  business: UcpBusiness,
  opts: SearchOptions,
  client: SearchClientOptions,
): Promise<SearchResult> {
  const url = `${business.endpoint}/catalog/search`
  const body = JSON.stringify(buildSearchRequest(opts))
  let headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'ucp-agent': `profile="${client.profileUrl}"`,
    'request-id': randomUUID(),
    'idempotency-key': randomUUID(),
  }
  if (client.signingKey) headers = signRequest({ method: 'POST', url, headers, body }, client.signingKey)

  const res = await (client.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new UcpError('http', `catalog/search ${res.status}: ${text.slice(0, 300)}`, res.status)
  }

  const json = await readJson(res) as {
    ucp?: { capabilities?: Record<string, unknown> }
    products?: UcpProduct[]
    messages?: unknown[]
    pagination?: { cursor?: string; has_next_page?: boolean }
  }
  if (!Array.isArray(json.products)) throw new UcpError('bad_response', 'catalog/search response has no products[]')
  return {
    status: res.status,
    products: json.products.map(p => normalizeProduct(p, business)),
    messages: json.messages ?? [],
    nextCursor: json.pagination?.has_next_page ? json.pagination.cursor : undefined,
    negotiated: Object.keys(json.ucp?.capabilities ?? {}),
  }
}
