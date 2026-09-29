import { getAllJobs, insertJob } from './store.js'
import { isHostedMode } from '../hostedMode.js'

/**
 * Insert built-in default jobs if they don't already exist.
 * Called at startup.
 */
export function seedDefaultJobs() {
  const existing = getAllJobs('self')
  const hasOutfitJob = existing.some(j => j.type === 'daily_outfit')
  if (!hasOutfitJob) {
    insertJob({
      userId: 'self',
      name: 'Daily Outfit',
      type: 'daily_outfit',
      schedule: '0 8 * * *',
      params: {},
    })
  }
  // #315 — the OpenRouter spend reconciler cross-checks per-user key spend
  // against the wallet ledger. Self-host has no per-user keys and no wallet,
  // so don't seed it there (and getExecutionPolicy blocks any leftover row).
  const hasSpendReconciler = existing.some(j => j.type === 'openrouter_spend_reconciler')
  if (isHostedMode() && !hasSpendReconciler) {
    insertJob({
      userId: 'self',
      name: 'OpenRouter Spend Reconciler',
      type: 'openrouter_spend_reconciler',
      schedule: '0 4 * * 0',
      params: {},
    })
  }
  const hasShareInboxCleanup = existing.some(j => j.type === 'share_inbox_cleanup')
  if (!hasShareInboxCleanup) {
    insertJob({
      userId: 'self',
      name: 'Share Inbox Cleanup',
      type: 'share_inbox_cleanup',
      schedule: '*/30 * * * *',
      params: {},
    })
  }
  // Embeddings reconciler — guarantees item image embeddings exist (issue #283).
  // Discover's image mode is a no-op without them: pre-filters fall through to
  // deterministic full-closet ordering and visually-distinct uploads return the
  // same shortlist. Runs for every row in the tables regardless of the 'self'
  // owner — each embedding row is written under its own item/outfit userId.
  const hasEmbeddingsReconciler = existing.some(j => j.type === 'embeddings_reconciler')
  if (!hasEmbeddingsReconciler) {
    insertJob({
      userId: 'self',
      name: 'Embeddings Reconciler',
      type: 'embeddings_reconciler',
      schedule: '0 3 * * *',
      params: {},
    })
  }
}
