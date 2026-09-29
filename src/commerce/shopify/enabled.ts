/**
 * #324 — the Related shop row, Liked items and /.well-known/ucp are off unless
 * SHOP_ROW_ENABLED=true. Shopify's Global Catalog fetches our agent profile, so
 * a self-hosted instance only works if /.well-known/ucp is publicly reachable;
 * vastra.cc turns it on in render.yaml. Read per call so tests can flip it.
 */
export function isShopEnabled(): boolean {
  return process.env.SHOP_ROW_ENABLED === 'true'
}
