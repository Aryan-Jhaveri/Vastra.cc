import { z } from 'zod'
import { getOutfitWithItems } from '../../tools/outfits.js'
import type { JobType, JobContext, JobRunResult } from '../registry.js'

export const OutfitReminderParamsSchema = z.object({
  outfitId: z.string().min(1),
})

export type OutfitReminderParams = z.infer<typeof OutfitReminderParamsSchema>

type HydratedOutfit = NonNullable<Awaited<ReturnType<typeof getOutfitWithItems>>>

// Snapshot the resolved outfit into an OutfitSuggestion shape. Mirrors the
// frontend helper in RemindersTab.tsx so the run's resultJson is self-contained
// and the Reminders tab still renders the outfit after the source outfit is
// deleted. `items` rides along (consumed by OutfitCard) — the suggestion is
// built as an inferred object so the extra field doesn't trip the backend
// OutfitSuggestion excess-property check.
function hydratedOutfitToSuggestion(outfit: HydratedOutfit) {
  let item_ids: string[] = []
  try {
    item_ids = JSON.parse(outfit.itemIds) as string[]
  } catch {
    /* malformed — leave empty */
  }
  return {
    item_ids,
    name: outfit.name,
    occasion: outfit.occasion ?? '',
    reasoning: outfit.notes ?? '',
    items: outfit.items,
  }
}

export const outfitReminderJob: JobType<OutfitReminderParams> = {
  key: 'outfit_reminder',
  description: 'Reminds you to wear a saved outfit. Shows the outfit in your Reminders tab when it fires.',
  scheduleHint: 'e.g. "0 8 * * 1" for Monday 8am, "0 7 * * 1,3,5" for Mon/Wed/Fri 7am',

  paramsSchema: OutfitReminderParamsSchema,

  async execute(params, ctx: JobContext): Promise<JobRunResult | void> {
    const { outfitId } = params

    const outfit = await getOutfitWithItems(outfitId, ctx.userId)
    if (!outfit) {
      console.warn(`[outfit_reminder] Outfit ${outfitId} not found — skipping`)
      return
    }

    // Persist the resolved outfit so the run survives later deletion of the
    // source outfit (durable Reminders history).
    return { suggestions: [hydratedOutfitToSuggestion(outfit)] }
  },
}
