/**
 * Canonical theme ids — mirror of src/constants/themes.ts.
 * Duplicated because the frontend Docker build context excludes the rest of src/.
 * Kept in sync by test/constants/themes-sync.test.ts.
 */
export const VALID_THEME_IDS = ['brutalist', 'atelier', 'silk', 'terra'] as const
export type ThemeId = (typeof VALID_THEME_IDS)[number]

export function isValidThemeId(id: string): id is ThemeId {
  return (VALID_THEME_IDS as readonly string[]).includes(id)
}
