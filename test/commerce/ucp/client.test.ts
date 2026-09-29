import { describe, it, expect, vi } from 'vitest'
import {
  buildSearchRequest,
  discoverBusiness,
  normalizeOrigin,
  normalizeProduct,
  searchCatalog,
  UcpError,
  type UcpBusiness,
} from '../../../src/commerce/ucp/client.js'
import { generatePrivateJwk, loadSigningKey, verifyRequestSignature } from '../../../src/commerce/ucp/signing.js'

const businessProfile = {
  ucp: {
    version: '2026-08-25',
    services: {
      'dev.ucp.shopping': [
        { version: '2026-08-25', transport: 'mcp', endpoint: 'https://shop.example/mcp' },
        { version: '2026-08-25', transport: 'rest', endpoint: 'https://shop.example/ucp/' },
      ],
    },
    capabilities: {
      'dev.ucp.shopping.catalog.search': [{ version: '2026-08-25' }],
      'dev.ucp.shopping.checkout': [{ version: '2026-08-25' }],
    },
    payment_handlers: {},
  },
}

const product = {
  id: 'prod_1',
  title: 'Waxed Rain Jacket',
  url: 'https://shop.example/products/rain',
  description: { plain: 'Keeps you dry.' },
  categories: [{ value: 'Apparel > Outerwear', taxonomy: 'merchant' }, { value: '5598', taxonomy: 'google_product_category' }],
  price_range: { min: { amount: 18900, currency: 'CAD' }, max: { amount: 18900, currency: 'CAD' } },
  media: [{ type: 'video', url: 'https://cdn.example/v.mp4' }, { type: 'image', url: 'https://cdn.example/rain.jpg' }],
  variants: [{ id: 'v1', title: 'M', price: { amount: 18900, currency: 'CAD' }, availability: { available: true }, seller: { name: 'Shop Example' } }],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const business: UcpBusiness = {
  origin: 'https://shop.example',
  endpoint: 'https://shop.example/ucp',
  version: '2026-08-25',
  capabilities: ['dev.ucp.shopping.catalog.search'],
}

describe('normalizeOrigin', () => {
  it('adds https:// to bare hosts and strips paths', () => {
    expect(normalizeOrigin('shop.example/anything')).toBe('https://shop.example')
  })

  it('rejects plain http except for localhost', () => {
    expect(() => normalizeOrigin('http://shop.example')).toThrow(UcpError)
    expect(normalizeOrigin('http://localhost:4000')).toBe('http://localhost:4000')
  })
})

describe('discoverBusiness', () => {
  it('picks the REST shopping endpoint and lists capabilities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(businessProfile))
    const b = await discoverBusiness('shop.example', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('https://shop.example/.well-known/ucp', expect.anything())
    expect(b).toEqual({
      origin: 'https://shop.example',
      endpoint: 'https://shop.example/ucp',
      version: '2026-08-25',
      capabilities: ['dev.ucp.shopping.catalog.search', 'dev.ucp.shopping.checkout'],
    })
  })

  it('reports a missing profile', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    await expect(discoverBusiness('shop.example', fetchImpl)).rejects.toMatchObject({ code: 'no_profile', status: 404 })
  })

  it('reports a business without catalog search', async () => {
    const noSearch = { ucp: { ...businessProfile.ucp, capabilities: { 'dev.ucp.shopping.checkout': [] } } }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(noSearch))
    await expect(discoverBusiness('shop.example', fetchImpl)).rejects.toMatchObject({ code: 'no_catalog_search' })
  })

  it('reports a business without a REST service', async () => {
    const mcpOnly = { ucp: { ...businessProfile.ucp, services: { 'dev.ucp.shopping': [{ transport: 'mcp', endpoint: 'https://x/mcp' }] } } }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(mcpOnly))
    await expect(discoverBusiness('shop.example', fetchImpl)).rejects.toMatchObject({ code: 'no_rest_service' })
  })
})

describe('buildSearchRequest', () => {
  it('only sends allowlisted fields', () => {
    const body = buildSearchRequest({
      query: 'rain jacket',
      categories: ['Outerwear'],
      maxPriceMinor: 20000,
      country: 'CA',
      limit: 5,
      // Extra fields must never leak into the outbound body.
      ...({ userId: 'user-a', email: 'a@example.com', itemIds: ['i1'] } as object),
    })
    expect(body).toEqual({
      query: 'rain jacket',
      context: { address_country: 'CA' },
      filters: { categories: ['Outerwear'], price: { max: 20000 } },
      pagination: { limit: 5 },
    })
  })

  it('omits empty sections', () => {
    expect(buildSearchRequest({ query: 'scarf' })).toEqual({ query: 'scarf' })
  })
})

describe('normalizeProduct', () => {
  it('maps a UCP product to a Vastra product card', () => {
    expect(normalizeProduct(product, business)).toEqual({
      id: 'prod_1',
      title: 'Waxed Rain Jacket',
      url: 'https://shop.example/products/rain',
      imageUrl: 'https://cdn.example/rain.jpg',
      price: { amountMinor: 18900, currency: 'CAD' },
      merchant: 'Shop Example',
      categories: ['Apparel > Outerwear', '5598'],
      available: true,
    })
  })

  it('falls back to the store hostname and tolerates missing optional fields', () => {
    const bare = { id: 'p2', title: 'Scarf', variants: [{ availability: { available: false } }] }
    expect(normalizeProduct(bare, business)).toMatchObject({
      merchant: 'shop.example',
      imageUrl: undefined,
      price: undefined,
      categories: [],
      available: false,
    })
  })
})

describe('searchCatalog', () => {
  const profileUrl = 'https://vastra.cc/.well-known/ucp'

  it('POSTs a signed search to {endpoint}/catalog/search', async () => {
    const key = loadSigningKey(JSON.stringify(generatePrivateJwk()))
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      ucp: { version: '2026-08-25', capabilities: { 'dev.ucp.shopping.catalog.search': [{ version: '2026-08-25' }] } },
      products: [product],
      pagination: { cursor: 'c2', has_next_page: true },
    }))

    const result = await searchCatalog(business, { query: 'rain jacket', limit: 3 }, { profileUrl, signingKey: key, fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://shop.example/ucp/catalog/search')
    expect(init.method).toBe('POST')
    expect(init.headers['ucp-agent']).toBe(`profile="${profileUrl}"`)
    expect(init.headers['request-id']).toBeTruthy()
    expect(init.headers['idempotency-key']).toBeTruthy()
    expect(verifyRequestSignature({ method: 'POST', url, headers: init.headers, body: init.body }, key.publicJwk)).toBe(true)

    expect(result.products).toHaveLength(1)
    expect(result.nextCursor).toBe('c2')
    expect(result.negotiated).toEqual(['dev.ucp.shopping.catalog.search'])
  })

  it('sends no signature headers when unsigned', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ucp: {}, products: [] }))
    await searchCatalog(business, { query: 'scarf' }, { profileUrl, signingKey: null, fetchImpl })
    const headers = fetchImpl.mock.calls[0][1].headers
    expect(headers).not.toHaveProperty('signature')
    expect(headers).not.toHaveProperty('signature-input')
  })

  it('surfaces business messages on HTTP 200', async () => {
    const messages = [{ type: 'warning', code: 'partial_results' }]
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ucp: {}, products: [], messages }))
    const result = await searchCatalog(business, { query: 'scarf' }, { profileUrl, fetchImpl })
    expect(result.messages).toEqual(messages)
  })

  it('throws UcpError with the status on transport errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    await expect(searchCatalog(business, { query: 'scarf' }, { profileUrl, fetchImpl }))
      .rejects.toMatchObject({ code: 'http', status: 401 })
  })

  it('rejects responses without products[]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ucp: {} }))
    await expect(searchCatalog(business, { query: 'scarf' }, { profileUrl, fetchImpl }))
      .rejects.toMatchObject({ code: 'bad_response' })
  })
})
