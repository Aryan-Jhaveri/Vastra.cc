/**
 * Canonical color names — mirror of src/constants/colors.ts.
 * Duplicated because the frontend Docker build context excludes the rest of src/.
 * Kept in sync by test/constants/colors-sync.test.ts.
 */
export const COLORS = [
  'black', 'white', 'gray', 'charcoal', 'cream', 'beige', 'ivory', 'off-white',
  'brown', 'tan', 'camel', 'khaki', 'chocolate',
  'navy', 'blue', 'light blue', 'sky blue', 'cobalt', 'royal blue', 'denim',
  'green', 'olive', 'sage', 'forest green', 'mint', 'teal', 'emerald',
  'red', 'burgundy', 'maroon', 'pink', 'blush', 'coral', 'rose',
  'orange', 'rust', 'yellow', 'mustard', 'gold',
  'purple', 'lavender', 'lilac', 'violet', 'plum',
  'silver', 'bronze',
  'multicolor', 'striped', 'plaid', 'floral', 'camo', 'tie-dye',
] as const