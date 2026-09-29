/** Curated subset of COLORS shown as preset chips in color multi-select UI */
export const PRESET_COLORS = [
  'black', 'white', 'gray', 'charcoal', 'cream', 'beige', 'ivory', 'off-white',
  'brown', 'tan', 'camel', 'khaki',
] as const

/** Canonical color names used for AI output normalization and search */
export const COLORS = [
  // Neutrals
  'black', 'white', 'gray', 'charcoal', 'cream', 'beige', 'ivory', 'off-white',
  // Browns
  'brown', 'tan', 'camel', 'khaki', 'chocolate',
  // Blues
  'navy', 'blue', 'light blue', 'sky blue', 'cobalt', 'royal blue', 'denim',
  // Greens
  'green', 'olive', 'sage', 'forest green', 'mint', 'teal', 'emerald',
  // Reds & Pinks
  'red', 'burgundy', 'maroon', 'pink', 'blush', 'coral', 'rose',
  // Oranges & Yellows
  'orange', 'rust', 'yellow', 'mustard', 'gold',
  // Purples
  'purple', 'lavender', 'lilac', 'violet', 'plum',
  // Metallics
  'silver', 'bronze',
  // Patterns (AI may return these as "color")
  'multicolor', 'striped', 'plaid', 'floral', 'camo', 'tie-dye',
] as const

export type Color = typeof COLORS[number]

export const COLOR_SET = new Set<string>(COLORS)

export function isValidColor(value: string): value is Color {
  return COLOR_SET.has(value)
}

/**
 * Normalize a raw AI color string to a canonical color.
 * Strips qualifiers like "dark ", "light ", "bright " and tries to match.
 * Returns the input unchanged if no match found.
 */
export function normalizeColor(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (isValidColor(lower)) return lower

  // Strip common qualifiers and retry
  const stripped = lower
    .replace(/^(dark|light|bright|deep|pale|dusty|muted|warm|cool)\s+/, '')
  if (isValidColor(stripped)) return stripped

  return lower
}
