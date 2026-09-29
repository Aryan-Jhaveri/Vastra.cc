import { loadSigningKey, type PublicJwk, type SigningKey } from './signing.js'

export const UCP_VERSION = '2026-08-25'
const SPEC_BASE = `https://ucp.dev/${UCP_VERSION}`

export const CAP_CATALOG_SEARCH = 'dev.ucp.shopping.catalog.search'
export const CAP_CATALOG_LOOKUP = 'dev.ucp.shopping.catalog.lookup'
// Shopify extensions the Global Catalog requires an agent profile to declare (#324).
export const CAP_SHOPIFY_CATALOG = 'dev.shopify.catalog'
export const CAP_SHOPIFY_CATALOG_GLOBAL = 'dev.shopify.catalog.global'
const SHOPIFY_SCHEMA_BASE = `https://shopify.dev/ucp/schemas/${UCP_VERSION}`

/**
 * Vastra's UCP platform profile, served at /.well-known/ucp (#323, #324).
 * Businesses fetch it (via the UCP-Agent header) to negotiate capabilities
 * and to verify our request signatures against `keys[]`. The Shopify Global
 * Catalog does not require signatures, so the profile is served even when
 * no signing key is configured (#324) — `keys` is empty in that case.
 */
export function buildPlatformProfile(publicJwk?: PublicJwk) {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': [{
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/overview`,
          transport: 'rest',
          schema: `${SPEC_BASE}/services/shopping/rest.openapi.json`,
        }, {
          // The Global Catalog is an MCP endpoint.
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/overview`,
          transport: 'mcp',
          schema: `${SPEC_BASE}/services/shopping/mcp.openrpc.json`,
        }],
      },
      capabilities: {
        [CAP_CATALOG_SEARCH]: [{
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/shopping/catalog/search`,
          schema: `${SPEC_BASE}/schemas/shopping/catalog_search.json`,
        }],
        [CAP_CATALOG_LOOKUP]: [{
          version: UCP_VERSION,
          spec: `${SPEC_BASE}/specification/shopping/catalog/lookup`,
          schema: `${SPEC_BASE}/schemas/shopping/catalog_lookup.json`,
        }],
        [CAP_SHOPIFY_CATALOG]: [{
          version: UCP_VERSION,
          spec: 'https://shopify.dev/docs/agents/catalog/storefront-catalog',
          schema: `${SHOPIFY_SCHEMA_BASE}/shopify_catalog.json`,
          extends: [CAP_CATALOG_LOOKUP, CAP_CATALOG_SEARCH],
        }],
        [CAP_SHOPIFY_CATALOG_GLOBAL]: [{
          version: UCP_VERSION,
          spec: 'https://shopify.dev/docs/agents/catalog/global-catalog',
          schema: `${SHOPIFY_SCHEMA_BASE}/shopify_catalog_global.json`,
          extends: [CAP_CATALOG_LOOKUP, CAP_CATALOG_SEARCH],
        }],
      },
      // Handoff-only checkout (#325): Vastra never acquires payment instruments.
      payment_handlers: {},
    },
    keys: publicJwk ? [publicJwk] : [],
  }
}

let cachedKey: SigningKey | null | undefined

/** The platform signing key from UCP_SIGNING_KEY, or null when UCP is not configured. */
export function platformSigningKey(): SigningKey | null {
  if (cachedKey !== undefined) return cachedKey
  const raw = process.env.UCP_SIGNING_KEY
  cachedKey = raw ? loadSigningKey(raw) : null
  return cachedKey
}

/** Test hook — forget the cached key so env changes take effect. */
export function resetPlatformSigningKey(): void {
  cachedKey = undefined
}

/** Must point at /.well-known/ucp on a host businesses can reach. */
export function platformProfileUrl(): string {
  if (process.env.UCP_PROFILE_URL) return process.env.UCP_PROFILE_URL
  const base = process.env.APP_BASE_URL ?? 'https://vastra.cc'
  return new URL('/.well-known/ucp', base).toString()
}
