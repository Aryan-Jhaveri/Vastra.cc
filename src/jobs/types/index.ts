import { registerJobType } from '../registry.js'
import { hostedHooks } from '../../hostedHooks.js'
import { dailyOutfitJob } from './dailyOutfit.js'
import { outfitReminderJob } from './outfitReminder.js'
import { embeddingsReconcilerJob } from './embeddingsReconciler.js'
import { shareInboxCleanupJob } from './shareInboxCleanup.js'

export function registerBuiltInJobTypes(): void {
  registerJobType(dailyOutfitJob)
  registerJobType(outfitReminderJob)
  registerJobType(embeddingsReconcilerJob)
  registerJobType(shareInboxCleanupJob)
  for (const job of hostedHooks().jobTypes) registerJobType(job)
}

export { dailyOutfitJob, outfitReminderJob, embeddingsReconcilerJob, shareInboxCleanupJob }
