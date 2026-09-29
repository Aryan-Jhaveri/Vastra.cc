import { COLORS } from '../constants/colors'

const COLOR_SET = new Set<string>(COLORS)

export function normalizeColor(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (COLOR_SET.has(lower)) return lower
  const stripped = lower
    .replace(/^(dark|light|bright|deep|pale|dusty|muted|warm|cool)\s+/, '')
  if (COLOR_SET.has(stripped)) return stripped
  return lower
}