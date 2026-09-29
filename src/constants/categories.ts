export const CATEGORIES = {
  tops:        ['t-shirt', 'shirt', 'blouse', 'sweater', 'hoodie', 'tank top', 'polo', 'cardigan', 'turtleneck'],
  bottoms:     ['jeans', 'trousers', 'shorts', 'skirt', 'leggings', 'sweatpants', 'chinos'],
  dresses:     ['dress', 'jumpsuit', 'romper'],
  outerwear:   ['jacket', 'coat', 'blazer', 'vest', 'parka', 'raincoat'],
  shoes:       ['sneakers', 'boots', 'loafers', 'heels', 'sandals', 'flats', 'oxfords'],
  accessories: ['hat', 'cap', 'scarf', 'belt', 'watch', 'sunglasses', 'bag', 'jewelry'],
  activewear:  ['sports top', 'sports bra', 'gym shorts', 'leggings', 'tracksuit'],
  underwear:   ['socks', 'underwear', 'bra'],
} as const

export type Category = keyof typeof CATEGORIES
export type Subcategory = typeof CATEGORIES[Category][number]

export const CATEGORY_KEYS = Object.keys(CATEGORIES) as Category[]

export function isValidCategory(value: string): value is Category {
  return value in CATEGORIES
}

export function isValidSubcategory(category: Category, value: string): boolean {
  return (CATEGORIES[category] as readonly string[]).includes(value)
}

export function getSubcategories(category: Category): readonly string[] {
  return CATEGORIES[category]
}

/** Find which category a subcategory belongs to, or null if not found */
export function categoryForSubcategory(subcategory: string): Category | null {
  for (const [cat, subs] of Object.entries(CATEGORIES)) {
    if ((subs as readonly string[]).includes(subcategory)) {
      return cat as Category
    }
  }
  return null
}
