import { z } from 'zod'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { sharePayloads } from '../../db/schema.js'
import { deleteImage } from '../../storage/images.js'
import type { JobType, JobContext, JobRunResult } from '../registry.js'

export const ShareInboxCleanupParamsSchema = z.object({})

export type ShareInboxCleanupParams = z.infer<typeof ShareInboxCleanupParamsSchema>

type SharePayloadRow = typeof sharePayloads.$inferSelect

export const shareInboxCleanupJob: JobType<ShareInboxCleanupParams> = {
  key: 'share_inbox_cleanup',
  description:
    'Purges expired inbound PWA share rows (source=share_inbox) and unlinks their images. Covers unclaimed anonymous shares (15-min TTL, under users/__anon__/) and authed inbox rows whose chooser was dismissed. Claimed rows have a 30-day expiry so they are not in this cohort.',
  scheduleHint: 'e.g. "*/30 * * * *" for every 30 minutes',

  paramsSchema: ShareInboxCleanupParamsSchema,

  async execute(_params, _ctx: JobContext): Promise<JobRunResult> {
    const now = Date.now()
    // NOTE: intentionally NOT filtered to userId='__anon__'. Authed inbox rows
    // also carry a finite expiry; a dismissed chooser should still get cleaned.
    const expired = db
      .select()
      .from(sharePayloads)
      .where(and(eq(sharePayloads.source, 'share_inbox'), lt(sharePayloads.expiresAt, now)))
      .all() as SharePayloadRow[]

    let files = 0
    for (const row of expired) {
      const uris: string[] = (() => {
        try {
          return JSON.parse(row.imageUris ?? '[]') as string[]
        } catch {
          return []
        }
      })()
      for (const uri of uris) {
        // deleteImage resolves under the row's owning user tree and also removes
        // the _thumb sibling. Tolerate already-missing files.
        await deleteImage(uri, row.userId).catch(() => {})
        files++
      }
      db.delete(sharePayloads).where(eq(sharePayloads.id, row.id)).run()
    }

    const summary = `share_inbox cleanup: rows=${expired.length} files=${files}`
    if (expired.length) console.log(`[share-inbox-cleanup] ${summary}`)
    return { summary }
  },
}
