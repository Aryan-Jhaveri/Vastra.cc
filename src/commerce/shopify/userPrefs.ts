import { getSettings } from '../../settings.js'
import type { CatalogGender } from './catalog.js'

// Per-user catalog filters, shared by /api/shop/* and the Ask shop tools
// (#341) so both send Shopify the same thing — and nothing more.

export function userCountry(userId: string): string | undefined {
  // Only a geocoded ISO code is used; never the request, never coordinates.
  const loc = getSettings(userId).serverLocation
  return loc?.enabled ? loc.countryCode : undefined
}

export function userShopGender(userId: string): CatalogGender | undefined {
  // Opt-in Settings → Style & Show → "Shop for"; `any`/unset sends no filter.
  const g = getSettings(userId).shopGender
  return g === 'female' || g === 'male' ? g : undefined
}
