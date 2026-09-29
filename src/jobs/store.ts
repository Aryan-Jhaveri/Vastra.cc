import { db } from '../db/client.js'
import { scheduledJobs } from '../db/schema.js'
import { eq, and, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'

export type ScheduledJob = typeof scheduledJobs.$inferSelect
export type NewScheduledJob = typeof scheduledJobs.$inferInsert

// Job types that are internal system crons — hidden from user-facing job lists.
export const INTERNAL_JOB_TYPES = new Set([
  'openrouter_spend_reconciler',
  'share_inbox_cleanup',
  'embeddings_reconciler',
])

// Closed allowlist of job types a user may create via the API. Registry
// membership is not enough: internal jobs (above) operate across all tenants
// and are seeded by the server, never scheduled by users.
export const USER_JOB_TYPES = new Set([
  'daily_outfit',
  'outfit_reminder',
])

export interface CreateJobInput {
  name: string
  type: string
  schedule: string
  params?: Record<string, unknown>
  userId: string
}

export function getAllJobs(userId: string): ScheduledJob[] {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.userId, userId)).all()
}

export function getEnabledJobs(userId: string): ScheduledJob[] {
  return db.select().from(scheduledJobs)
    .where(and(eq(scheduledJobs.enabled, 1), eq(scheduledJobs.userId, userId))).all()
}

// Privileged scheduler enumeration; never use this in a user-facing tool/route.
export function getEnabledJobsForScheduler(): ScheduledJob[] {
  return db.select().from(scheduledJobs).where(eq(scheduledJobs.enabled, 1)).all()
}

export function getJob(id: string, userId: string): ScheduledJob | undefined {
  return db.select().from(scheduledJobs)
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId))).get()
}

export function insertJob(input: CreateJobInput): ScheduledJob {
  return db.insert(scheduledJobs).values({
    id: nanoid(),
    userId: input.userId,
    name: input.name,
    type: input.type,
    schedule: input.schedule,
    params: JSON.stringify(input.params ?? {}),
    enabled: 1,
    createdAt: Date.now(),
  }).returning().get() as ScheduledJob
}

export function updateJobLastRun(id: string, userId: string): void {
  db.update(scheduledJobs)
    .set({ lastRunAt: Date.now() })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId)))
    .run()
}

export function updateJob(
  id: string,
  data: { name?: string; schedule?: string; params?: Record<string, unknown> },
  userId: string,
): ScheduledJob | undefined {
  return db.transaction(tx => {
    const updated = tx.update(scheduledJobs)
    .set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.schedule !== undefined && { schedule: data.schedule }),
      ...(data.params !== undefined && { params: JSON.stringify(data.params) }),
    })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId), sql`run_state = 'idle'`))
    .returning().get()
    if (updated && data.schedule !== undefined) {
      tx.run(sql`UPDATE scheduled_jobs SET next_run_at = NULL, retry_at = NULL, attempt_count = 0
        WHERE id = ${id} AND user_id = ${userId}`)
    }
    return updated
  })
}

export function toggleJob(id: string, enabled: boolean, userId: string): ScheduledJob | undefined {
  return db.update(scheduledJobs)
    .set({ enabled: enabled ? 1 : 0 })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId),
      ...(enabled ? [sql`run_state <> 'manual_recovery'`] : [])))
    .returning().get() as ScheduledJob | undefined
}

export function deleteJob(id: string, userId: string): void {
  db.delete(scheduledJobs).where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.userId, userId))).run()
}
