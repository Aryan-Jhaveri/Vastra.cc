/**
 * Shopify CDN host allowlist + a byte-capped body reader (#324).
 *
 * Kept apart from catalog.ts so the image proxy's SSRF guard doesn't depend on
 * (and isn't mocked away with) the catalog client.
 */

/** Shopify-operated CDN hosts. Matched exactly or as a dot-suffix, so
 *  `evilshopify.com` does not pass. `myshopify.com` is deliberately absent:
 *  every merchant controls a subdomain of it. */
export const SHOPIFY_CDN_HOST_SUFFIXES = ['shopify.com', 'shopifycdn.com', 'shopifyassets.com'] as const

export function isShopifyCdnHost(hostname: string): boolean {
  return SHOPIFY_CDN_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

/**
 * Read a response body with a byte cap, cancelling the stream once it is
 * exceeded. Checking length after `res.text()`/`arrayBuffer()` would already
 * have buffered the whole body.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new BodyTooLargeError()
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new BodyTooLargeError()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export class BodyTooLargeError extends Error {
  constructor() { super('response body too large') }
}
