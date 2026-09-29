import type { Item } from '../api/items'
import type { HydratedOutfit } from '../api/outfits'

export function parseColors(item: Item): string[] {
  try { return JSON.parse(item.colors || '[]') as string[] } catch { return [] }
}

// Search predicate shared by the Closet search bar (applyItemFilters) and the
// Outfits search bar (outfitMatchesSearch) so the two can't drift. `query` is
// normalized here: empty/whitespace matches everything.
export function itemMatchesSearch(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    item.category.toLowerCase().includes(q) ||
    (item.subcategory?.toLowerCase().includes(q) ?? false) ||
    (item.brand?.toLowerCase().includes(q) ?? false) ||
    (item.aiDescription?.toLowerCase().includes(q) ?? false) ||
    parseColors(item).some(c => c.toLowerCase().includes(q)) ||
    (() => { try { return (JSON.parse(item.occasion || '[]') as string[]).some(o => o.toLowerCase().includes(q)) } catch { return false } })() ||
    (() => { try { return (JSON.parse(item.tags || '[]') as string[]).some(t => t.toLowerCase().includes(q)) } catch { return false } })() ||
    (() => { try { return (JSON.parse(item.careInstructions || '[]') as string[]).some(c => c.toLowerCase().includes(q)) } catch { return false } })()
  )
}

// Matches every field rendered on SavedOutfitCard: name, notes, occasion,
// season[], tags[], the AI badge, plus each hydrated item through the Closet
// item-search fields (and the item card's material / primaryColor, which the
// Closet search doesn't cover).
export function outfitMatchesSearch(outfit: HydratedOutfit, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true

  let seasons: string[] = []
  try { seasons = JSON.parse(outfit.season || '[]') as string[] } catch { /* ignore */ }
  let tags: string[] = []
  try { tags = JSON.parse(outfit.tags || '[]') as string[] } catch { /* ignore */ }

  const itemMatch = outfit.items?.some(i =>
    itemMatchesSearch(i, q) ||
    (i.material?.toLowerCase().includes(q) ?? false) ||
    (i.primaryColor?.toLowerCase().includes(q) ?? false)
  )

  return (
    (outfit.name?.toLowerCase().includes(q) ?? false) ||
    (outfit.notes?.toLowerCase().includes(q) ?? false) ||
    (outfit.occasion?.toLowerCase().includes(q) ?? false) ||
    seasons.some(s => s.toLowerCase().includes(q)) ||
    tags.some(t => t.toLowerCase().includes(q)) ||
    (outfit.aiGenerated === 1 && q === 'ai') ||
    (itemMatch ?? false)
  )
}
