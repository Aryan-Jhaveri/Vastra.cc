import type { UserSizes } from '../api/settings'

// Settings › Sizes (#329). Keys mirror CATEGORY_KEYS in the backend's
// src/constants/categories.ts — the server rejects anything else with 400.

/** Shown by default, in this order. */
export const PRIMARY_SIZE_CATEGORIES = ['tops', 'bottoms', 'outerwear', 'dresses', 'shoes'] as const
/** Behind "+ Add a size" unless one already has a value. */
export const EXTRA_SIZE_CATEGORIES = ['activewear', 'accessories', 'underwear'] as const
export const SIZE_CATEGORIES = [...PRIMARY_SIZE_CATEGORIES, ...EXTRA_SIZE_CATEGORIES] as const

export const MAX_SIZE_LENGTH = 30

export function sizeCategoryLabel(category: string): string {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

/** "Tops M · Bottoms 32×30 · Shoes US 10" — set categories in display order. */
export function formatSizesSummary(sizes: UserSizes | undefined): string {
  if (!sizes) return ''
  return SIZE_CATEGORIES
    .filter(c => sizes[c])
    .map(c => `${sizeCategoryLabel(c)} ${sizes[c]}`)
    .join(' · ')
}
