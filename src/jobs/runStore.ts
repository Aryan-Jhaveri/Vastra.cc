import { db } from '../db/client.js'
import { jobRuns } from '../db/schema.js'
import { eq, and, gte, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { OutfitSuggestion } from '../types/index.js'

export type JobRun = typeof jobRuns.$inferSelect

export function insertJobRun(input: {
  jobId: string
  status: 'success' | 'failed' | 'skipped'
  suggestions?: OutfitSuggestion[]
  error?: string
}, userId: string): JobRun {
  return db.insert(jobRuns).values({
    id: nanoid(),
    userId,
    jobId: input.jobId,
    firedAt: Date.now(),
    status: input.status,
    resultJson: input.suggestions ? JSON.stringify(input.suggestions) : null,
    error: input.error,
  }).returning().get() as JobRun
}

export function getRecentJobRuns(days: number, userId: string): JobRun[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  return db.select().from(jobRuns)
    .where(and(eq(jobRuns.userId, userId), gte(jobRuns.firedAt, since)))
    .orderBy(desc(jobRuns.firedAt))
    .all() as JobRun[]
}

export function getJobRunsByJob(jobId: string, userId: string, limit = 5): JobRun[] {
  return db.select().from(jobRuns)
    .where(and(eq(jobRuns.jobId, jobId), eq(jobRuns.userId, userId)))
    .orderBy(desc(jobRuns.firedAt))
    .limit(limit)
    .all() as JobRun[]
}

export function deleteAllJobRuns(userId: string): void {
  db.delete(jobRuns).where(eq(jobRuns.userId, userId)).run()
}
