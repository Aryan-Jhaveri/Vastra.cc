import type { Item, Outfit } from '../types/index.js'

/**
 * Item / outfit text sent to Jev-Noul questions. One builder for every Jev call
 * site (Suggest outfit ranking, Discover item ranking, occasion-fit pool
 * ranking, Related Outfits) so they all compare the same item-card details.
 *
 * Jev infers fit (dressiness, occasion, warmth) from the text, so the blob
 * carries everything the item card shows: the full colour list, brand, and
 * the AI description on top of the structured fields. The description is
 * capped to keep a 40-outfit batch within a sane request size.
 *
 * Deliberately omitted: ids (question keys already carry them), size, care
 * instructions, wear counts, image URIs. Nothing here identifies the user;
 * `decisions.ts` also rejects `user_*` state keys.
 */

export const DECISION_DESCRIPTION_MAX_CHARS = 200

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function capText(text: string | null | undefined, max: number): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** Drop undefined values and empty arrays so Jev only sees populated fields. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out as Partial<T>
}

export function itemDecisionBlob(item: Item) {
  return compact({
    category: item.category,
    subcategory: item.subcategory ?? undefined,
    primaryColor: item.primaryColor ?? undefined,
    colors: parseList(item.colors),
    material: item.material ?? undefined,
    brand: item.brand ?? undefined,
    season: parseList(item.season),
    occasion: parseList(item.occasion),
    tags: parseList(item.tags),
    wearContext: item.wearContext ?? undefined,
    description: capText(item.aiDescription, DECISION_DESCRIPTION_MAX_CHARS),
  })
}

/**
 * Outfit blob: outfit-level labels plus the full blob of every item still in
 * the closet. `items` is empty when every item was deleted — callers skip
 * those outfits rather than ask Jev to rank an empty look.
 */
export function outfitDecisionBlob(outfit: Outfit, itemsById: Map<string, Item>) {
  const items = parseList(outfit.itemIds)
    .map(id => itemsById.get(id))
    .filter((i): i is Item => Boolean(i))
    .map(itemDecisionBlob)
  return {
    ...compact({
      name: outfit.name,
      occasion: outfit.occasion ?? undefined,
      season: parseList(outfit.season),
      tags: parseList(outfit.tags),
    }),
    items,
  }
}
