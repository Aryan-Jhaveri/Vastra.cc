import { COLORS } from '../constants/colors.js'
import { generateJSONWithUsage, VISION_MODEL, type UsageMetadata } from './client.js'

export interface InspirationContext {
  description: string
  /**
   * 2-4 dominant colors from the canonical COLORS vocabulary — the same names
   * items are tagged with, so text embeddings and Jev can match them (#283).
   */
  dominantColors: string[]
  vibe: string
  garmentHints: string[]
  /** Distinct materials visible in the image (denim, leather, linen, …). */
  materials: string[]
}

export async function analyzeInspiration(imageBase64: string): Promise<{ data: InspirationContext; usage: UsageMetadata }> {
  const prompt = `Analyze this inspiration image and describe the style context for outfit matching.
Be concrete and specific — the description feeds a closet-matching engine, so boilerplate ("casual outfit, neutral tones") is worse than nothing.
Return ONLY valid JSON with no markdown:
{
  "description": "1-2 sentence style description naming exact silhouettes (e.g. oversized cropped boxy, wide-leg, tailored slim) and materials (e.g. raw denim, satin, wool knit)",
  "dominantColors": ["color1", "color2", "color3"],
  "vibe": "single evocative descriptor (e.g. 'cozy minimalist', 'bold streetwear')",
  "garmentHints": ["key garment types or styles visible"],
  "materials": ["material1", "material2"]
}
Rules:
- dominantColors: 2-4 of the most dominant colors, each chosen from this exact list (pick the most specific match, e.g. "mustard" over "yellow"): ${COLORS.join(', ')}.
- description must mention at least one silhouette word and one material word.
- If a field genuinely has nothing, use an empty array, never "none" blurbs.`

  return generateJSONWithUsage<InspirationContext>(prompt, imageBase64, VISION_MODEL)
}
