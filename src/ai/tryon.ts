import { copyFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { vertexAiImageGen, IMAGE_GEN_MODEL, withRetry, isModelBusy, generateJSONWithUsage, type UsageMetadata } from './client.js'
import { freeTextModel } from './localModel.js'
import { imageGenModel, isLocalImageGen, localImageEdit } from './localImage.js'
import { extractGeminiImage, parseAIJSON } from './parse.js'
import { saveImageFromBase64, getUserImagesDir } from '../storage/images.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const MOCK_TRYON_FIXTURE = join(FIXTURES_DIR, 'mock-tryon.jpg')

/** A refine chip, scoped to one of the selected garments (#312). */
export interface WearSuggestion {
  label: string
  instruction: string
  /** 0-based index into the garments the suggestions were generated for. */
  itemIndex: number
}

export interface WearGarment {
  /** buildGarmentContext() text: category, description, tags, wear context. */
  context: string
  /** Small compressed primary view (base64 JPEG), when the model can take images. */
  imageBase64?: string
}

/** The saved outfit the try-on started from, when there is one. */
export interface WearOutfitContext {
  name: string
  occasion?: string | null
  season?: string[]
}

const MAX_SUGGESTIONS = 6

export function buildWearSuggestionsPrompt(garments: WearGarment[], outfit?: WearOutfitContext): string {
  const withImages = garments.length > 0 && garments.every(g => g.imageBase64)
  const outfitLines = outfit
    ? [
        '',
        `These garments are the saved outfit "${outfit.name}"` +
          (outfit.occasion ? `, worn for ${outfit.occasion}` : '') +
          (outfit.season?.length ? `, in ${outfit.season.join('/')}` : '') + '.',
      ]
    : []
  return [
    'You are a fashion stylist. The person is virtually trying on exactly these garments, and nothing else:',
    '',
    ...garments.map((g, i) => `${i + 1}. ${g.context}`),
    ...(withImages ? ['', `The images are the garments in the same order: image 1 is garment 1, and so on. Trust the images over the text when they disagree.`] : []),
    ...outfitLines,
    '',
    `Suggest 4-${MAX_SUGGESTIONS} different ways to WEAR these garments: tucked or untucked, sleeves rolled, open or closed, belted with its own belt, collar up, draped or wrapped (headwear, scarves), layer order among the listed garments.`,
    'Rules:',
    '- Every suggestion restyles ONE listed garment. Never add, suggest or mention a garment, accessory or item that is not in the list (no new belts, turtlenecks, jewellery or shoes).',
    '- Only suggest what fits that garment (no tucking a dress, no belting a garment that has no belt).',
    '',
    'Return ONLY a valid JSON array, no markdown. Each element:',
    '- "item": the garment number from the list (1-based integer)',
    '- "label": 2-4 word chip label (e.g. "Collar up", "Belted")',
    '- "instruction": one sentence saying exactly how to wear that garment, naming it',
    '',
    'Example: [{"item": 1, "label": "Belted", "instruction": "Belt the trench coat closed at the waist."}]',
  ].join('\n')
}

/** Keep well-formed chips that point at a listed garment; drop the rest. */
export function normalizeWearSuggestions(raw: unknown, garmentCount: number): WearSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: WearSuggestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { item, label, instruction } = entry as Record<string, unknown>
    if (typeof label !== 'string' || !label.trim() || typeof instruction !== 'string' || !instruction.trim()) continue
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > garmentCount) continue
    out.push({ label: label.trim().slice(0, 40), instruction: instruction.trim().slice(0, 300), itemIndex: item - 1 })
    if (out.length === MAX_SUGGESTIONS) break
  }
  return out
}

/**
 * Refine chips for the garments being tried on (#312). A free task: callers
 * wrap it in runInstrumented with freeTextModel(). Images are sent only when
 * every garment has one (the caller leaves them out for text-only models).
 * Never throws for a model failure: no chips is better than a failed try-on.
 */
export async function generateWearSuggestions(
  garments: WearGarment[],
  opts: { outfit?: WearOutfitContext } = {},
): Promise<{ data: WearSuggestion[]; usage: UsageMetadata }> {
  if (!garments.length) return { data: [], usage: { tokensIn: 0, tokensOut: 0 } }

  const prompt = buildWearSuggestionsPrompt(garments, opts.outfit)
  const images = garments.every(g => g.imageBase64) ? garments.map(g => g.imageBase64!) : undefined

  try {
    // Free task: Gemini, or a local/ TEXT_MODEL (see freeTextModel).
    const { data, usage } = await generateJSONWithUsage<unknown>(prompt, images, freeTextModel())
    return { data: normalizeWearSuggestions(data, garments.length), usage }
  } catch (err) {
    if (isModelBusy(err)) {
      console.warn('[tryon/suggestions] Model still busy after retries — returning empty suggestions')
    } else {
      console.error('[tryon/suggestions] Failed:', err instanceof Error ? err.message : err)
    }
    return { data: [], usage: { tokensIn: 0, tokensOut: 0 } }
  }
}

// Adapted from gemini-ai-tryon (oyeolamilekan/gemini-ai-tryon) — prompt v2.0
const TRYON_PROMPT = `Generate a photorealistic virtual try-on image.

CORE CONSTRAINTS (ABSOLUTE):
- identity_lock: Maintain PERFECT facial identity, features, skin tone, and expression from person image. ZERO alterations to the face permitted. DO NOT GUESS OR HALLUCINATE FACIAL FEATURES.
- body_lock: Keep the SAME person — body shape, build, height, proportions, hair and gender presentation exactly as in the person image. Fit the garments to this body; never swap in a different body or a model whose body suits the garments.
- garment_fidelity: Preserve EXACT color, pattern, texture, material, and design details from the clothing images. ZERO deviations allowed.
- pose_preservation: Retain exact body pose and positioning from the person image.

ADDITIONAL:
- Simulate physically plausible draping and fit of the garments onto the person's body.
- Maintain hair and non-clothing accessories unless logically occluded.
- Apply consistent lighting across person and garments.
- Render fine details (seams, buttons, texture) with high fidelity.

PROHIBITIONS:
- DO NOT alter facial features, identity, expression, or skin tone.
- DO NOT use, copy or blend in any person, face, body or mannequin that appears in a clothing image. Take ONLY the clothing from those images.
- DO NOT modify the color, pattern, or style of any clothing item.
- DO NOT change the person's pose.
- DO NOT hallucinate or guess facial details.`

/**
 * Assemble the try-on prompt. The request sends the clothing images first and
 * the person photo LAST, so the prompt names each image's role explicitly.
 *
 * Order matters: Gemini image models treat the final image as the canvas to
 * edit (the output takes its aspect ratio). With the person first, the model
 * "edited" the last garment photo and invented a person to wear it.
 *
 * Garment contexts are numbered against clothing images only when the counts
 * match (primary-view mode, no ad-hoc uploads). Otherwise they're listed as
 * unordered hints. The images win when text and image disagree.
 */
export function buildPrompt(clothingImageCount: number, garmentContexts?: string[], userInstruction?: string): string {
  let prompt = TRYON_PROMPT

  const personIndex = clothingImageCount + 1
  prompt += '\n\nIMAGE ROLES:\n'
  if (clothingImageCount === 1) {
    prompt += '- Image 1 is a CLOTHING item to dress the person in.\n'
  } else if (clothingImageCount > 1) {
    prompt += `- Images 1–${clothingImageCount} are CLOTHING items to dress the person in, all together as one outfit.\n`
  }
  prompt += `- Image ${personIndex} (the LAST image) is the PERSON. Edit THIS image: keep this exact person, face, body, pose and background framing, and change only their clothing. This is the only person who may appear in the output.\n`

  if (garmentContexts?.length) {
    const aligned = garmentContexts.length === clothingImageCount
    prompt += aligned
      ? '\nGARMENT CONTEXT (helps interpret each clothing image; if text and image disagree, follow the IMAGE):\n'
      : '\nGARMENT CONTEXT (hints about the clothing, not in image order; if text and image disagree, follow the IMAGE):\n'
    garmentContexts.forEach((ctx, i) => {
      prompt += aligned ? `Image ${i + 1}: ${ctx}\n` : `- ${ctx}\n`
    })
  }

  if (userInstruction?.trim()) {
    prompt += `\n\nWEAR INSTRUCTION (user-specified styling — apply this to how the garments are placed):\n`
    prompt += userInstruction.trim()
  }

  return prompt
}

/**
 * Generate a virtual try-on image.
 *
 * In mock mode (MOCK_AI_IMAGE_GEN=true), copies a fixture image instead of calling
 * the Vertex API. The fixture is written to the same images/tryon/ location so
 * downstream code (DB rows, image route) works without modification.
 *
 * @param userImageBase64 - Base64 of the person photo (square-padded; sent last)
 * @param itemImageBase64s - Base64 array of clothing item images
 * @param garmentContexts - Optional structured descriptions of each garment (category, subcategory, tags)
 * @param userInstruction - Optional user-specified styling instruction (e.g. "worn as a turban")
 * @returns Relative path to the saved result image (e.g. "images/tryon/abc.jpg")
 */
export async function generateTryOn(
  userImageBase64: string,
  itemImageBase64s: string[],
  userId: string,
  garmentContexts?: string[],
  userInstruction?: string,
): Promise<string> {
  if (process.env.MOCK_AI_IMAGE_GEN === 'true') {
    const destFilename = `${nanoid()}.jpg`
    const tryonDir = join(getUserImagesDir(userId), 'tryon')
    mkdirSync(tryonDir, { recursive: true })
    const destPath = join(tryonDir, destFilename)
    copyFileSync(MOCK_TRYON_FIXTURE, destPath)
    const thumbPath = join(tryonDir, `${destFilename.slice(0, -4)}_thumb.jpg`)
    copyFileSync(MOCK_TRYON_FIXTURE, thumbPath)
    console.log('[MOCK] tryon')
    return `images/tryon/${destFilename}`
  }

  // Person LAST — see buildPrompt for why the order matters. The local image
  // model (#352) gets the same order and prompt; the route has already cut
  // the garment views to fit its reference limit.
  const model = imageGenModel()
  if (isLocalImageGen(model)) {
    const { data } = await localImageEdit({
      model,
      prompt: buildPrompt(itemImageBase64s.length, garmentContexts, userInstruction),
      images: [...itemImageBase64s, userImageBase64],
      userId,
    })
    return saveImageFromBase64(data, 'tryon', userId)
  }

  const parts = [
    ...itemImageBase64s.map(img => ({
      inlineData: { mimeType: 'image/jpeg', data: img },
    })),
    { inlineData: { mimeType: 'image/jpeg', data: userImageBase64 } },
    { text: buildPrompt(itemImageBase64s.length, garmentContexts, userInstruction) },
  ]

  const response = await withRetry(
    () => vertexAiImageGen.models.generateContent({
      model: IMAGE_GEN_MODEL,
      contents: [{ role: 'user', parts }],
      // The person photo is square-padded (imageToBase64SquarePadded), so pin
      // the output to 1:1 rather than letting a garment photo's shape win.
      config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '1:1' } },
    }),
    { label: '[tryon/image-gen]', delayMs: 3000 },
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = extractGeminiImage(response as any)
  return saveImageFromBase64(data, 'tryon', userId)
}
