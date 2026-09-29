import { Router } from 'express'
import {
  getSettings,
  updateSettings,
  isValidThemeId,
  isValidColorScheme,
  isValidCustomThemePalettes,
  isValidCustomPaletteSlot,
  parseServerLocation,
  isValidShopGender,
  parseUserSizesPatch,
  MAX_SIZE_LENGTH,
  type SettingsPatch,
  type ThemeId,
  type ColorScheme,
} from '../../../settings.js'

const router = Router()

// GET /api/settings
router.get('/', (req, res) => {
  res.json(getSettings(req.userId!))
})

// PATCH /api/settings
router.patch('/', (req, res) => {
  try {
    const userId = req.userId!
    const patch = req.body as Record<string, unknown>
    const allowed: SettingsPatch = {}
    if (typeof patch.navWidth === 'number' && Number.isFinite(patch.navWidth)) {
      allowed.navWidth = patch.navWidth
    }
    if (typeof patch.themeId === 'string' && isValidThemeId(patch.themeId)) {
      allowed.themeId = patch.themeId as ThemeId
    }
    if (typeof patch.colorScheme === 'string' && isValidColorScheme(patch.colorScheme)) {
      allowed.colorScheme = patch.colorScheme as ColorScheme
    }
    if (patch.customPalettes !== undefined) {
      if (!isValidCustomThemePalettes(patch.customPalettes)) {
        return res.status(400).json({ error: 'Invalid customPalettes' })
      }
      allowed.customPalettes = patch.customPalettes
    }
    if (patch.customPaletteSlot !== undefined) {
      if (patch.customPaletteSlot !== null && !isValidCustomPaletteSlot(patch.customPaletteSlot)) {
        return res.status(400).json({ error: 'Invalid customPaletteSlot' })
      }
      // Selecting a slot needs a saved palette in it (this patch or stored).
      if (patch.customPaletteSlot !== null) {
        const available = allowed.customPalettes ?? getSettings(userId).customPalettes
        if (!available?.[patch.customPaletteSlot]) return res.status(400).json({ error: 'Custom palette slot is empty' })
      }
      allowed.customPaletteSlot = patch.customPaletteSlot
    }
    if (patch.shopGender !== undefined) {
      if (!isValidShopGender(patch.shopGender)) return res.status(400).json({ error: 'Invalid shopGender' })
      allowed.shopGender = patch.shopGender
    }
    if (patch.serverLocation !== undefined) {
      const location = parseServerLocation(patch.serverLocation)
      // Reject rather than silently ignore: a client must not believe a
      // location was saved when it was not.
      if (!location) return res.status(400).json({ error: 'Invalid serverLocation' })
      allowed.serverLocation = location
    }
    if (patch.userSizes !== undefined) {
      // Same reject-not-ignore rule: an unknown category or an over-long value
      // fails the whole request instead of silently dropping that entry.
      const sizes = parseUserSizesPatch(patch.userSizes)
      if (!sizes) {
        return res.status(400).json({
          error: `Invalid userSizes: keys must be clothing categories and values strings of at most ${MAX_SIZE_LENGTH} characters`,
        })
      }
      allowed.userSizes = sizes
    }
    if (patch.sizesAgentContext !== undefined) {
      if (typeof patch.sizesAgentContext !== 'boolean') {
        return res.status(400).json({ error: 'Invalid sizesAgentContext' })
      }
      allowed.sizesAgentContext = patch.sizesAgentContext
    }
    const updated = updateSettings(allowed, userId)
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
