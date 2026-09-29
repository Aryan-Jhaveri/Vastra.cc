import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { vertexAiImageGen as ai, IMAGE_GEN_MODEL, withRetry } from './client.js'
import { extractGeminiImage } from './parse.js'
import { imageGenModel, isLocalImageGen, localImageEdit } from './localImage.js'
import { saveImageFromBase64, getUserImagesDir } from '../storage/images.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const MOCK_HERO_FIXTURE = join(FIXTURES_DIR, 'mock-hero.jpg')

// Ported from prototypes/lib/hero_image.py — direct variant only.
// No rembg preprocessing: Gemini handles raw images well on its own.
const HERO_PROMPT = `You are generating a clean product photograph of ONE specific clothing or accessory item from {N} reference photo(s). The item may be a garment (top, jacket, dress, trousers), footwear, a bag, jewellery, a hat, or any other wearable accessory.

Goal:
  Output a studio flat-lay or display-style photo of THAT SINGLE ITEM only. No person, no environment, no props.
  Neutral light grey or off-white background with a soft natural shadow.

Constraints (non-negotiable):
  - OUTPUT EXACTLY ONE ITEM — the primary item that is the clear subject of the reference
    photos. Do NOT add any other clothing, accessories, or objects that is not
    the primary subject. If the person is wearing or holding multiple items, output only the most prominent.
  - SINGLE CANONICAL VIEW — choose ONE flat-lay or display perspective. Do not blend or composite multiple
    viewing angles. Do not show the item from multiple directions simultaneously.
  - CORRECT STRUCTURE — the item has exactly the structure a real item has. For garments: two sleeves for
    a top, one body panel, one collar. Do not generate extra structural elements or duplicate any part.
  - EACH GRAPHIC APPEARS EXACTLY ONCE — logos, prints, text, badges, and embroidery each appear
    in their single correct position. Do not repeat or tile any graphic element.
  - Preserve color exactly. Preserve material texture (knit / denim / silk / leather / metal / ceramic).
  - Do NOT invent details not visible in any reference. If a region is fully occluded in every
    reference photo, infer minimally and conservatively.

Process:
  1. Identify the single primary item across the {N} reference image(s).
  2. Decide on ONE canonical flat-lay or display orientation (front-facing is preferred).
  3. Render it with high fidelity, natural drape or placement — no person, no extra items, no duplicate elements.
  4. Output one high-resolution image containing only that item.`

/**
 * Generate a studio flat-lay hero image from 1-N reference photos of an item.
 * Returns the relative path to the saved generated image (e.g. "images/items/<nanoid>.jpg").
 *
 * In mock mode (MOCK_AI_IMAGE_GEN=true), copies a fixture image instead of calling
 * the Vertex API. The fixture is written to the same images/items/ location so
 * downstream code (DB rows, image route) works without modification.
 *
 * @param imageBase64s - Array of base64-encoded JPEG reference photos
 * @param extraInstruction - Optional additional instruction appended to the prompt
 */
export async function generateHeroImage(
  imageBase64s: string[],
  userId: string,
  extraInstruction?: string,
): Promise<string> {
  if (!imageBase64s.length) throw new Error('At least one reference image is required')

  if (process.env.MOCK_AI_IMAGE_GEN === 'true') {
    const destFilename = `${nanoid()}.jpg`
    const itemsDir = join(getUserImagesDir(userId), 'items')
    mkdirSync(itemsDir, { recursive: true })
    const destPath = join(itemsDir, destFilename)
    copyFileSync(MOCK_HERO_FIXTURE, destPath)
    const thumbPath = join(itemsDir, `${destFilename.slice(0, -4)}_thumb.jpg`)
    copyFileSync(MOCK_HERO_FIXTURE, thumbPath)
    console.log('[MOCK] heroImage')
    return `images/items/${destFilename}`
  }

  const model = imageGenModel()
  if (isLocalImageGen(model)) {
    let prompt = HERO_PROMPT.replace(/\{N\}/g, String(imageBase64s.length))
    if (extraInstruction?.trim()) prompt += `\n\nAdditional instruction: ${extraInstruction.trim()}`
    // Make Pretty settings from the Qwen-Image-2.1 recipe (#352).
    const { data } = await localImageEdit({ model, prompt, images: imageBase64s, userId, steps: 40, trueCfgScale: 1.0 })
    return saveImageFromBase64(data, 'items', userId)
  }

  const parts: Array<Record<string, unknown>> = imageBase64s.map(data => ({
    inlineData: { mimeType: 'image/jpeg', data },
  }))

  let prompt = HERO_PROMPT.replace(/\{N\}/g, String(imageBase64s.length))
  if (extraInstruction?.trim()) {
    prompt += `\n\nAdditional instruction: ${extraInstruction.trim()}`
  }
  parts.push({ text: prompt })

  const response = await withRetry(
    () => ai.models.generateContent({
      model: IMAGE_GEN_MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
    { label: '[heroImage]', delayMs: 3000 },
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = extractGeminiImage(response as any)
  return saveImageFromBase64(data, 'items', userId)
}
