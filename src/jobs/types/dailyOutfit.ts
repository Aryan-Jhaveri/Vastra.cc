import { z } from 'zod'
import { listItems } from '../../tools/items.js'
import { getCurrentWeather } from '../../tools/weather.js'
import { suggestOutfits } from '../../ai/suggest.js'
import { localTime } from '../../time/zone.js'
import type { JobType, JobContext, JobRunResult } from '../registry.js'
import type { Item } from '../../types/index.js'

export const DailyOutfitParamsSchema = z.object({
  lat: z.number().optional(),
  lon: z.number().optional(),
  locationName: z.string().optional(),
  theme: z.string().optional(),
})

export type DailyOutfitParams = z.infer<typeof DailyOutfitParamsSchema>

export const dailyOutfitJob: JobType<DailyOutfitParams> = {
  key: 'daily_outfit',
  description: 'Weather-based outfit suggestion. Add an optional theme to guide the AI (e.g. "formal business meeting", "casual weekend").',
  scheduleHint: 'e.g. "0 8 * * *" for 8am every day, "0 9 * * 1" for Monday 9am',

  paramsSchema: DailyOutfitParamsSchema,

  async execute(params, ctx: JobContext): Promise<JobRunResult | void> {
    const { lat, lon, theme } = params

    if (!lat || !lon) return

    const weather = await getCurrentWeather(lat, lon)

    const allItems = await listItems({}, ctx.userId)
    if (allItems.length < 2) return

    // The location's wall clock (from the weather lookup), not the server's UTC.
    const local = localTime(new Date(), weather.timezone)
    const suggestions = await suggestOutfits(
      weather,
      allItems,
      ctx.userId,
      theme as string | undefined,
      undefined,
      local.hour,
      local.weekday,
      ctx.jobId,
    )

    if (!suggestions.length) return

    // Hydrate each suggestion's items from the user's closet so the Reminders
    // tab (OutfitCard) can render thumbnails. The AI layer only returns item_ids;
    // callers do the hydration.
    const itemsById = new Map(allItems.map(i => [i.id, i]))
    const suggestionsWithItems = suggestions.map(s => ({
      ...s,
      items: s.item_ids.map(id => itemsById.get(id)).filter((i): i is Item => Boolean(i)),
    }))

    return { suggestions: suggestionsWithItems }
  },
}
