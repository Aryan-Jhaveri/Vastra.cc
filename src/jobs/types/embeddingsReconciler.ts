import { z } from 'zod'
import {
  backfillItemTextEmbeddings,
  backfillOutfitTextEmbeddings,
  backfillShareTextEmbeddings,
  backfillItemImageEmbeddings,
  backfillOutfitImageEmbeddings,
  backfillShareImageEmbeddings,
  reembedStaleTextEmbeddings,
} from '../../ai/embedBackfill.js'
import type { JobType, JobContext, JobRunResult } from '../registry.js'

export const EmbeddingsReconcilerParamsSchema = z.object({})

export type EmbeddingsReconcilerParams = z.infer<typeof EmbeddingsReconcilerParamsSchema>

export const embeddingsReconcilerJob: JobType<EmbeddingsReconcilerParams> = {
  key: 'embeddings_reconciler',
  description: 'Periodically scans for items/outfits/shares missing current-model text or image embeddings and fills the gaps, then re-embeds items/outfits whose metadata changed after their text embedding (capped per run). Safe to run repeatedly.',
  scheduleHint: 'e.g. "0 3 * * *" for daily at 3am',

  paramsSchema: EmbeddingsReconcilerParamsSchema,

  async execute(_params, _ctx: JobContext): Promise<JobRunResult> {
    const [textItems, textOutfits, textShares, imgItems, imgOutfits, imgShares] = await Promise.all([
      backfillItemTextEmbeddings('embed_reconcile'),
      backfillOutfitTextEmbeddings('embed_reconcile'),
      backfillShareTextEmbeddings('embed_reconcile'),
      backfillItemImageEmbeddings('embed_reconcile'),
      backfillOutfitImageEmbeddings('embed_reconcile'),
      backfillShareImageEmbeddings('embed_reconcile'),
    ])

    // #376 — after the gap fill, so a row is never both backfilled and
    // re-embedded in one run (the backfill only touches rows with no vector).
    const stale = await reembedStaleTextEmbeddings('embed_reconcile')

    const summary = [
      `text: items=${textItems} outfits=${textOutfits} shares=${textShares}`,
      `image: items=${imgItems} outfits=${imgOutfits} shares=${imgShares}`,
      `stale: items=${stale.items} outfits=${stale.outfits} unchanged=${stale.unchanged}`,
    ].join(' | ')

    console.log(`[reconciler] ${summary}`)

    return { summary }
  },
}
