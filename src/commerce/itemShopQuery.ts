import type { Item } from '../types/index.js'

// #332 — the shop search for "Related shop items" in ItemDetail, built
// server-side from the anchor item: what would complete it, described by the
// item's own attributes. Privacy (#327, #329): only this text (and the coarse
// country, added by the catalog client) leaves the server. No ids, image,
// brand or size.

const COMPLEMENTS: Record<string, string> = {
  tops: 'bottoms, outerwear or shoes',
  bottoms: 'tops or shoes',
  outerwear: 'tops and bottoms',
  dresses: 'shoes, bags or outerwear',
  shoes: 'outfit pieces',
  bags: 'outfit pieces',
  accessories: 'outfit pieces',
  activewear: 'activewear pieces',
}

const MAX_WORDS_PART = 40

function clean(value: string | null | undefined): string | undefined {
  const v = value?.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, MAX_WORDS_PART).toLowerCase() : undefined
}

export function itemShopQuery(item: Pick<Item, 'category' | 'subcategory' | 'primaryColor' | 'material'>): string {
  const what = COMPLEMENTS[item.category] ?? 'outfit pieces'
  const described = [clean(item.primaryColor), clean(item.material), clean(item.subcategory) ?? clean(item.category) ?? 'piece']
    .filter(Boolean).join(' ')
  return `${what} to wear with a ${described}`
}
