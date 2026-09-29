import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildMcpSearchRequest,
  buildMcpLookupRequest,
  searchGlobalCatalog,
  lookupGlobalCatalog,
  normalizeCatalogProduct,
  resizeShopifyImage,
  APPAREL_CATEGORY_GIDS,
  productDecisionDetails,
} from '../../../src/commerce/shopify/catalog.js'
import { isShopifyCdnHost, readBodyCapped, BodyTooLargeError } from '../../../src/commerce/shopify/cdn.js'

const PROFILE = 'https://vastra.test/.well-known/ucp'

afterEach(() => {
  delete process.env.UCP_PROFILE_URL
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// ─── Request shape (#324 — the 422 "Missing profile uri" regression) ─────────
// Shape from https://shopify.dev/docs/agents/catalog/global-catalog: the profile
// lives at params.arguments.meta['ucp-agent'].profile inside a JSON-RPC 2.0 call.

describe('Global Catalog request shape', () => {
  it('sends a JSON-RPC 2.0 tools/call with the profile in arguments.meta', async () => {
    process.env.UCP_PROFILE_URL = PROFILE
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { structuredContent: { products: [] } } }))

    await searchGlobalCatalog({ query: 'linen shirt', intent: 'Outfit for 22°C sun', country: 'CA', limit: 10, cursor: 'c1' }, fetchImpl as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://catalog.shopify.com/api/ucp/mcp')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['ucp-agent']).toBe(`profile="${PROFILE}"`)

    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_catalog',
        arguments: {
          meta: { 'ucp-agent': { profile: PROFILE } },
          catalog: {
            query: 'linen shirt',
            context: { address_country: 'CA', intent: 'Outfit for 22°C sun' },
            filters: {
              categories: [...APPAREL_CATEGORY_GIDS],
              ships_to: { country: 'CA' },
            },
            pagination: { limit: 10, cursor: 'c1' },
          },
        },
      },
    })
  })

  it('never puts the profile anywhere Shopify ignores it', () => {
    process.env.UCP_PROFILE_URL = PROFILE
    const req = buildMcpSearchRequest({ query: 'q' }) as unknown as Record<string, unknown> & { params: Record<string, unknown> }
    expect(req.meta).toBeUndefined()
    expect(req.params._meta).toBeUndefined()
  })

  it('sends only query, filters and pagination when nothing else is known — no user data', () => {
    const req = buildMcpSearchRequest({ query: 'q' })
    const { catalog } = req.params.arguments as { catalog: Record<string, unknown> }
    expect(Object.keys(catalog).sort()).toEqual(['filters', 'pagination', 'query'])
    expect(catalog.context).toBeUndefined()
    expect(catalog.pagination).toEqual({ limit: 10 })
    expect(JSON.stringify(req)).not.toMatch(/user|email/i)
  })

  it('always limits to apparel categories, as GID strings (the live API rejects objects)', () => {
    const { catalog } = buildMcpSearchRequest({ query: 'q' }).params.arguments as { catalog: { filters: { categories: unknown[]; ships_to?: unknown } } }
    expect(catalog.filters.categories.length).toBeGreaterThan(0)
    for (const c of catalog.filters.categories) {
      expect(typeof c).toBe('string')
      expect(c).toMatch(/^gid:\/\/shopify\/TaxonomyCategory\/aa-\d+$/)
    }
    // No country → no ships_to (it requires one).
    expect(catalog.filters.ships_to).toBeUndefined()
  })

  it('adds a Target gender filter (with Unisex) only when a gender is set', () => {
    const withGender = buildMcpSearchRequest({ query: 'q', gender: 'female' }).params.arguments as { catalog: { filters: Record<string, unknown> } }
    expect(withGender.catalog.filters.attributes).toEqual([{ name: 'Target gender', values: ['Female', 'Unisex'] }])
    const male = buildMcpSearchRequest({ query: 'q', gender: 'male' }).params.arguments as { catalog: { filters: Record<string, unknown> } }
    expect(male.catalog.filters.attributes).toEqual([{ name: 'Target gender', values: ['Male', 'Unisex'] }])
    const none = buildMcpSearchRequest({ query: 'q' }).params.arguments as { catalog: { filters: Record<string, unknown> } }
    expect(none.catalog.filters.attributes).toBeUndefined()
  })

  it('sends price (minor units), price tier, sizes and currency only when set', () => {
    const { catalog } = buildMcpSearchRequest({
      query: 'q', country: 'IN', gender: 'female', currency: 'INR',
      minPriceMinor: 100000, maxPriceMinor: 500000, priceTiers: ['low', 'medium'], sizes: ['M', 'L'],
    }).params.arguments as { catalog: { filters: Record<string, unknown>; context: Record<string, unknown> } }
    expect(catalog.filters.price).toEqual({ min: 100000, max: 500000 })
    expect(catalog.filters.price_tier).toEqual(['low', 'medium'])
    expect(catalog.filters.ships_to).toEqual({ country: 'IN' })
    // Separate entries: AND between gender and size, OR within each.
    expect(catalog.filters.attributes).toEqual([
      { name: 'Target gender', values: ['Female', 'Unisex'] },
      { name: 'Size', values: ['M', 'L'] },
    ])
    expect(catalog.context).toEqual({ address_country: 'IN', currency: 'INR' })

    const maxOnly = buildMcpSearchRequest({ query: 'q', maxPriceMinor: 8000 }).params.arguments as { catalog: { filters: Record<string, unknown> } }
    expect(maxOnly.catalog.filters.price).toEqual({ max: 8000 })

    const none = buildMcpSearchRequest({ query: 'q' }).params.arguments as { catalog: { filters: Record<string, unknown>; context?: unknown } }
    expect(none.catalog.filters).not.toHaveProperty('price')
    expect(none.catalog.filters).not.toHaveProperty('price_tier')
    expect(none.catalog.filters).not.toHaveProperty('attributes')
    expect(none.catalog.context).toBeUndefined()
  })

  it('builds a lookup_catalog call for liked ids', () => {
    process.env.UCP_PROFILE_URL = PROFILE
    const req = buildMcpLookupRequest({ ids: ['gid://shopify/p/a', 'gid://shopify/p/b'], country: 'CA' })
    expect(req.params).toEqual({
      name: 'lookup_catalog',
      arguments: {
        meta: { 'ucp-agent': { profile: PROFILE } },
        catalog: { ids: ['gid://shopify/p/a', 'gid://shopify/p/b'], context: { address_country: 'CA' } },
      },
    })
  })

  it('refuses a lookup with no ids or more than 50', () => {
    expect(() => buildMcpLookupRequest({ ids: [] })).toThrow()
    expect(() => buildMcpLookupRequest({ ids: Array.from({ length: 51 }, (_, i) => `gid://shopify/p/${i}`) })).toThrow()
  })
})

// ─── Response handling ────────────────────────────────────────────────────────

describe('searchGlobalCatalog responses', () => {
  // Matches the live response: no product-level url, the link is on the variant.
  const liveShapedProduct = {
    id: 'gid://shopify/p/abc',
    title: 'Sunwashed Linen Shirt',
    media: [{ type: 'image', url: 'https://cdn.shopify.com/s/files/1/shirt.jpg', alt_text: 'shirt' }],
    price_range: { min: { amount: 19800, currency: 'CAD' }, max: { amount: 19800, currency: 'CAD' } },
    variants: [{
      url: 'https://faherty.example/products/linen',
      availability: { available: true },
      seller: { name: 'Faherty Brand', url: 'https://faherty.example' },
    }],
  }

  it('normalizes structuredContent products and returns the next cursor', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      jsonrpc: '2.0', id: 1,
      result: { structuredContent: { products: [liveShapedProduct], pagination: { has_next_page: true, cursor: 'next' } } },
    }))
    const result = await searchGlobalCatalog({ query: 'linen' }, fetchImpl as typeof fetch)
    expect(result.nextCursor).toBe('next')
    expect(result.products).toEqual([{
      id: 'gid://shopify/p/abc',
      title: 'Sunwashed Linen Shirt',
      imageUrl: 'https://cdn.shopify.com/s/files/1/shirt.jpg?width=400',
      price: '198.00 CAD',
      merchant: 'Faherty Brand',
      url: 'https://faherty.example/products/linen',
      available: true,
    }])
  })

  it('throws with the MCP error on a 422 profile failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      jsonrpc: '2.0', id: 1,
      error: { code: -32001, message: 'UCP discovery failed', data: { code: 'invalid_profile_url' } },
    }, 422))
    await expect(searchGlobalCatalog({ query: 'q' }, fetchImpl as typeof fetch)).rejects.toThrow(/HTTP 422.*invalid_profile_url/)
  })

  it('rejects an oversized body without buffering it all', async () => {
    const big = new Uint8Array(1024 * 1024)
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(big)
        if (pulled > 10) controller.close()
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }))
    await expect(searchGlobalCatalog({ query: 'q' }, fetchImpl as typeof fetch)).rejects.toThrow('too large')
    expect(pulled).toBeLessThanOrEqual(4) // stopped just past the 2 MB cap
  })

  it('throws on a tool-level error instead of reading it as no results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'Invalid arguments: value at `/catalog/filters/categories/0` is not a string' }], isError: true },
    }))
    await expect(searchGlobalCatalog({ query: 'q' }, fetchImpl as typeof fetch)).rejects.toThrow(/tool error: Invalid arguments/)
  })

  it('lookup returns live products and reports not-found ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      jsonrpc: '2.0', id: 1,
      result: { structuredContent: {
        products: [liveShapedProduct],
        messages: [{ type: 'info', code: 'not_found', content: 'gid://shopify/p/gone' }],
      } },
    }))
    const result = await lookupGlobalCatalog({ ids: ['gid://shopify/p/abc', 'gid://shopify/p/gone'] }, fetchImpl as typeof fetch)
    expect(result.products.map(p => p.id)).toEqual(['gid://shopify/p/abc'])
    expect(result.products[0].url).toBe('https://faherty.example/products/linen')
    expect(result.notFound).toEqual(['gid://shopify/p/gone'])
  })

  it('returns no cursor when there is no next page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      result: { structuredContent: { products: [], pagination: { has_next_page: false, cursor: 'stale' } } },
    }))
    const result = await searchGlobalCatalog({ query: 'q' }, fetchImpl as typeof fetch)
    expect(result.nextCursor).toBeNull()
  })
})

describe('normalizeCatalogProduct', () => {
  it('drops non-https links', () => {
    expect(normalizeCatalogProduct({ variants: [{ url: 'javascript:alert(1)' }] }).url).toBeNull()
    expect(normalizeCatalogProduct({ url: 'http://shop.example/p' }).url).toBeNull()
  })

  it('marks a product unavailable only when every variant is unavailable', () => {
    const p = normalizeCatalogProduct({ variants: [{ availability: { available: false } }] })
    expect(p.available).toBe(false)
    expect(p.merchant).toBe('Shopify store')
    expect(p.imageUrl).toBeNull()
  })
})

// ─── Host allowlist + body cap ────────────────────────────────────────────────

describe('isShopifyCdnHost', () => {
  it('accepts Shopify-operated hosts and subdomains', () => {
    expect(isShopifyCdnHost('cdn.shopify.com')).toBe(true)
    expect(isShopifyCdnHost('shopify.com')).toBe(true)
    expect(isShopifyCdnHost('img.shopifycdn.com')).toBe(true)
  })

  it('rejects lookalikes and merchant-controlled subdomains', () => {
    expect(isShopifyCdnHost('evilshopify.com')).toBe(false)
    expect(isShopifyCdnHost('cdn.shopify.com.evil.example')).toBe(false)
    expect(isShopifyCdnHost('anystore.myshopify.com')).toBe(false)
  })
})

describe('resizeShopifyImage', () => {
  it('adds width=400 on Shopify CDN hosts only', () => {
    expect(resizeShopifyImage('https://cdn.shopify.com/a.jpg')).toBe('https://cdn.shopify.com/a.jpg?width=400')
    expect(resizeShopifyImage('https://evilshopify.com/a.jpg')).toBe('https://evilshopify.com/a.jpg')
    expect(resizeShopifyImage('not a url')).toBe('not a url')
  })
})

describe('readBodyCapped', () => {
  it('rejects early on a declared content-length over the cap', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'content-length': '999999' } })
    await expect(readBodyCapped(res, 100)).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  it('returns the body when under the cap', async () => {
    const buf = await readBodyCapped(new Response('hello'), 100)
    expect(buf.toString()).toBe('hello')
  })
})

describe('productDecisionDetails (#324 Jev ranking)', () => {
  it('keeps title, colour labels, plain description and the first feature bullets', () => {
    const d = productDecisionDetails({
      id: 'gid://shopify/p/1',
      title: 'Laguna Linen Shirt',
      description: { plain: 'A breezy   linen shirt.', html: '<p>ignored</p>' },
      options: [
        { name: 'Size', values: [{ label: 'S' }, { label: 'M' }] },
        { name: 'Color', values: [{ label: 'Sand' }, { label: 'Navy' }] },
      ],
      metadata: { top_features: ['100% linen', 'Coconut buttons', 'Relaxed fit', 'Fourth is dropped'] },
      tags: ['akeneo_updated_at:123'],
    } as never)
    expect(d).toEqual({
      title: 'Laguna Linen Shirt',
      colors: ['Sand', 'Navy'],
      description: 'A breezy linen shirt.',
      features: ['100% linen', 'Coconut buttons', 'Relaxed fit'],
    })
    expect(JSON.stringify(d)).not.toContain('akeneo')
  })

  it('caps long merchant text and omits missing fields', () => {
    const d = productDecisionDetails({ title: 'T', description: { plain: 'x'.repeat(1000) } })
    expect(d.description!.length).toBeLessThanOrEqual(240)
    expect(d.colors).toBeUndefined()
    expect(d.features).toBeUndefined()
  })

  it('searchGlobalCatalog returns details keyed by product id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { structuredContent: { products: [{ id: 'gid://shopify/p/9', title: 'Tee', description: { plain: 'Soft tee' } }] } },
    }), { status: 200 }))
    const res = await searchGlobalCatalog({ query: 'tee' }, fetchImpl as unknown as typeof fetch)
    expect(res.details['gid://shopify/p/9']).toEqual({ title: 'Tee', description: 'Soft tee' })
  })
})
