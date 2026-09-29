import * as queries from '../db/queries.js'
import { imageToBase64Compressed, imageToBase64SquarePadded } from '../storage/images.js'
import { generateTryOn, generateWearSuggestions, type WearGarment, type WearOutfitContext } from '../ai/tryon.js'
import { imageGenMaxRefs, imageGenModel, isLocalImageGen, selectGarmentViews } from '../ai/localImage.js'
import { freeTextModel, isLocalModel } from '../ai/localModel.js'
import { runInstrumented, isMockImageGen } from '../ai/instrumented.js'
import { updateAiCallLinks } from '../ai/aiCalls.js'
import { tokenCost } from '../cost/tokenTable.js'
import type { AgentCallIdentity } from '../ai/messages.js'
import type { Item } from '../types/index.js'

// One try-on: shared by POST /api/tryon and the agent `try_on` tool, so both
// charge through the same runInstrumented seam (wallet in HOSTED_MODE, no-op
// self-hosted, zero when MOCK_AI_IMAGE_GEN), use the same garment contexts,
// and persist to Try On history the same way. Every lookup is by (id, userId).

export class TryOnNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'TryOnNotFoundError' }
}

export function buildGarmentContext(item: Item): string {
  const parts: string[] = []
  parts.push(`${item.category}${item.subcategory ? ` / ${item.subcategory}` : ''}`)
  if (item.aiDescription) parts.push(item.aiDescription)
  const tags = JSON.parse(item.tags ?? '[]') as string[]
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`)
  if ((item as Record<string, unknown>).wearContext) parts.push(`wear: ${(item as Record<string, unknown>).wearContext}`)
  return parts.join(' — ')
}

/** Tokens one try-on debits from the wallet (0 while image gen is mocked). */
export function tryOnCost(): number {
  return isMockImageGen() ? 0 : tokenCost('tryon')
}

export interface TryOnInput {
  userId: string
  userPhotoId: string
  itemIds?: string[]
  /** Ad-hoc garment uploads (web only; agents never upload media). */
  garmentUris?: string[]
  userInstruction?: string
  /** Links the history row to a saved outfit when the try-on came from one. */
  outfitId?: string
  /**
   * The saved outfit the web Try On was opened from. Only used as context for
   * the refine chips; unlike `outfitId` it doesn't link the history row.
   */
  sourceOutfitId?: string
  identity?: AgentCallIdentity
}

/** A refine chip for one of the tried-on closet items (#312). JSON-serialisable. */
export type TryOnWearSuggestion = {
  label: string
  instruction: string
  itemId: string
  /** Short garment name for the chip, e.g. "trench coat". */
  itemLabel: string
}

export interface TryOnOutput {
  resultImageUri: string
  tryonId: string
  wearSuggestions: TryOnWearSuggestion[]
  /** Extra garment views left out to fit a local image model's reference limit (#352). */
  droppedViews: number
}

export function itemChipLabel(item: Item): string {
  return (item.subcategory?.trim() || item.category).toLowerCase()
}

const CHIP_IMAGE = { maxDim: 384, quality: 60 }

function outfitContext(outfitId: string | undefined, userId: string): WearOutfitContext | undefined {
  if (!outfitId) return undefined
  const outfit = queries.getOutfit(outfitId, userId)
  if (!outfit) return undefined
  let season: string[] = []
  try {
    const parsed = JSON.parse(outfit.season ?? '[]') as unknown
    if (Array.isArray(parsed)) season = parsed.filter((v): v is string => typeof v === 'string')
  } catch { /* unreadable season → none */ }
  return { name: outfit.name, occasion: outfit.occasion, season }
}

/**
 * Refine chips for closet items being tried on (#312): each chip names one of
 * `items`. A free, best-effort task: it never throws, so a failure can't cost
 * the user a paid try-on. Sends each item's primary view (small) unless the
 * free text model is a local one, which may not take images.
 */
export async function suggestWearForItems(input: {
  userId: string
  items: Item[]
  /** Primary view per item, same order as `items`. */
  primaryUris?: string[]
  outfitId?: string
  identity?: AgentCallIdentity
}): Promise<TryOnWearSuggestion[]> {
  const { userId, items } = input
  if (!items.length) return []
  try {
    const model = freeTextModel()
    let images: string[] | undefined
    if (!isLocalModel(model)) {
      const uris = input.primaryUris ?? items.map(i => i.imageUri)
      images = await Promise.all(uris.map(uri => imageToBase64Compressed(uri, userId, CHIP_IMAGE)))
        .catch(err => {
          console.warn('[tryon] chip images unavailable, text only:', err instanceof Error ? err.message : err)
          return undefined
        })
    }
    const garments: WearGarment[] = items.map((item, i) => ({
      context: buildGarmentContext(item),
      ...(images ? { imageBase64: images[i] } : {}),
    }))
    const outfit = outfitContext(input.outfitId, userId)
    const chips = await runInstrumented({
      ...(input.identity ?? {}),
      userId,
      task: 'suggest',
      model,
      expectedBilledTokens: 0,
      call: async () => {
        const { data, usage } = await generateWearSuggestions(garments, { outfit })
        return { result: data, usage }
      },
    })
    return chips.map(c => ({
      label: c.label,
      instruction: c.instruction,
      itemId: items[c.itemIndex].id,
      itemLabel: itemChipLabel(items[c.itemIndex]),
    }))
  } catch (err) {
    console.warn('[tryon] wear suggestions failed (non-fatal):', err instanceof Error ? err.message : err)
    return []
  }
}

export async function runTryOn(input: TryOnInput): Promise<TryOnOutput> {
  const { userId, userPhotoId, itemIds, garmentUris, userInstruction } = input

  const userPhoto = queries.getUserPhotos(userId).find(p => p.id === userPhotoId)
  if (!userPhoto) throw new TryOnNotFoundError('User photo not found')

  const userBase64 = await imageToBase64SquarePadded(userPhoto.imageUri, userId)

  // Validate all items exist before kicking off parallel reads
  const items: Item[] = []
  for (const itemId of itemIds ?? []) {
    const item = queries.getItem(itemId, userId)
    if (!item) throw new TryOnNotFoundError(`Item ${itemId} not found`)
    items.push(item)
  }

  // Build ordered URI list + garment contexts in one pass.
  // Promise.all preserves input order, so push in the correct sequence:
  // item images in itemIds order, then garmentUris in input order.
  // One group of views per garment, best view first.
  const primaryViewOnly = process.env.TRYON_PRIMARY_VIEW_ONLY !== 'false'
  const garmentViews: string[][] = []
  const garmentContexts: string[] = []

  for (const item of items) {
    const itemImgs = queries.getItemImages(item.id, userId).filter(i => i.role !== 'source')
    if (primaryViewOnly) {
      const primary = itemImgs.find(i => i.isPrimary === 1)
      garmentViews.push([primary ? primary.imageUri : item.imageUri])
    } else if (itemImgs.length > 0) {
      garmentViews.push([...itemImgs].sort((a, b) => b.isPrimary - a.isPrimary).map(img => img.imageUri))
    } else {
      garmentViews.push([item.imageUri])
    }
    garmentContexts.push(buildGarmentContext(item))
  }

  for (const uri of garmentUris ?? []) {
    garmentViews.push([uri])
  }

  // #352 — a local image model takes a fixed number of references (the
  // person photo is one). Drop extra views before any garment; refuse,
  // before anything is charged, when the garments alone don't fit.
  let readUris = garmentViews.flat()
  let droppedViews = 0
  if (isLocalImageGen()) {
    const picked = selectGarmentViews(garmentViews, imageGenMaxRefs() - 1)
    readUris = picked.selected
    droppedViews = picked.droppedViews
  }

  const itemBase64s = await Promise.all(readUris.map(uri =>
    imageToBase64Compressed(uri, userId),
  ))

  const identity = input.identity ?? {}
  let tryonCallId: string | undefined
  const [resultImageUri, wearSuggestions] = await Promise.all([
    runInstrumented({
      ...identity,
      userId,
      task: 'tryon',
      model: imageGenModel(),
      expectedBilledTokens: tokenCost('tryon'),
      mocked: isMockImageGen(),
      onCallRecorded: (id) => { tryonCallId = id },
      call: async () => ({
        result: await generateTryOn(
          userBase64,
          itemBase64s,
          userId,
          garmentContexts.length ? garmentContexts : undefined,
          userInstruction?.trim() || undefined,
        ),
      }),
    }),
    // Best-effort (never rejects): a failure here must not reject
    // Promise.all, or the paid try-on above would be charged with its result
    // thrown away (orphaned image + no DB record).
    suggestWearForItems({
      userId,
      items,
      primaryUris: garmentViews.slice(0, items.length).map(views => views[0]),
      outfitId: input.outfitId ?? input.sourceOutfitId,
      identity: input.identity,
    }),
  ])

  // Persist the result
  const result = queries.insertTryonResult(userId, {
    userPhotoId,
    itemIds: JSON.stringify(itemIds),
    resultImageUri,
    promptInstruction: userInstruction?.trim() || null,
    ...(input.outfitId ? { outfitId: input.outfitId } : {}),
  })

  if (tryonCallId) {
    updateAiCallLinks(tryonCallId, {
      tryonResultId: result.id,
      outputImageUri: resultImageUri,
    })
  }

  return { resultImageUri, tryonId: result.id, wearSuggestions, droppedViews }
}
