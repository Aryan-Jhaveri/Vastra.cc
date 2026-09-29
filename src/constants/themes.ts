/** Canonical theme ids — single source of truth shared by backend & PWA */
export const VALID_THEME_IDS = ['brutalist', 'atelier', 'silk', 'terra'] as const
export type ThemeId = (typeof VALID_THEME_IDS)[number]

export function isValidThemeId(id: string): id is ThemeId {
  return (VALID_THEME_IDS as readonly string[]).includes(id)
}
