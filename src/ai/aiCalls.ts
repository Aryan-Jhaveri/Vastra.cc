import { eq, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiCalls } from '../db/schema.js'

// Per-call cost/token observability. Written in both modes (self-host and
// hosted); only the wallet that charges for calls is hosted-only.

export type AiCallRow = typeof aiCalls.$inferSelect
export type AiCallInsert = typeof aiCalls.$inferInsert

export function insertAiCall(row: AiCallInsert): string {
  db.insert(aiCalls).values(row).run()
  return row.id
}

/** Post-hoc backlinks (#189) — e.g. tryon result id after insertTryonResult. */
export function updateAiCallLinks(
  callId: string,
  links: Partial<Pick<AiCallInsert, 'tryonResultId' | 'jobId' | 'outputImageUri' | 'promptSnippet'>>,
): void {
  if (Object.keys(links).length === 0) return
  db.update(aiCalls).set(links).where(eq(aiCalls.id, callId)).run()
}

export function listAiCalls(userId: string, limit = 50): AiCallRow[] {
  return db.select()
    .from(aiCalls)
    .where(eq(aiCalls.userId, userId))
    .orderBy(desc(aiCalls.createdAt))
    .limit(limit)
    .all()
}
