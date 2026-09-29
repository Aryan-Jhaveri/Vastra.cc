// Explicit backfill: embed every item/outfit/share that lacks a current-model
// text embedding. Run once after flipping TEXT_EMBED_ENABLED, or after a
// TEXT_EMBED_MODEL/DIM change. Idempotent: rows whose model_version already
// matches are skipped, so re-runs are safe.
//
// Usage: TEXT_EMBED_ENABLED=true tsx src/scripts/backfillTextEmbeddings.ts

import {
  backfillItemTextEmbeddings,
  backfillOutfitTextEmbeddings,
  backfillShareTextEmbeddings,
} from '../ai/embedBackfill.js'

async function main(): Promise<void> {
  if (process.env.TEXT_EMBED_ENABLED !== 'true' && process.env.TEXT_EMBED_ENABLED !== '1') {
    console.error('TEXT_EMBED_ENABLED must be set to "true" or "1" to run backfill')
    process.exit(1)
  }

  const itemCount = await backfillItemTextEmbeddings('embed_backfill_manual')
  const outfitCount = await backfillOutfitTextEmbeddings('embed_backfill_manual')
  const shareCount = await backfillShareTextEmbeddings('embed_backfill_manual')

  console.log(`[backfill] items=${itemCount} outfits=${outfitCount} shares=${shareCount}`)
}

main().catch(err => {
  console.error('[backfill] fatal:', err)
  process.exit(1)
})
