import { Cron } from 'croner'
import { nanoid } from 'nanoid'
import { getSqlite } from '../db/client.js'
import { getJob, type ScheduledJob } from './store.js'
import { insertJobRun } from './runStore.js'
import type { JobRunResult } from './registry.js'
import { isHostedMode } from '../hostedMode.js'

export const CLAIM_LEASE_MS = 5 * 60_000
export const MAX_JOB_ATTEMPTS = 3
export const RETRY_BASE_MS = 30_000

// Deliberately closed allowlist. Registry membership alone does not authorize
// autonomous execution. Paid generation/new mutating agent jobs stay blocked.
export function getExecutionPolicy(type: string): 'retry-safe' | 'manual-on-failure' | 'blocked' {
  switch (type) {
    case 'daily_outfit': // Free Gemini suggestion; no wallet debit or wardrobe writes.
    case 'outfit_reminder':
    case 'openrouter_spend_reconciler': // Read-only usage cross-check.
      // #315 — the spend reconciler reconciles per-user OpenRouter key spend
      // against the wallet. Self-host has neither, so block any leftover row
      // from a hosted→self-host migration rather than running it pointlessly.
      if (type === 'openrouter_spend_reconciler' && !isHostedMode()) return 'blocked'
      return 'retry-safe'
    // Idempotent derived-data upserts; a retry only re-fills remaining gaps.
    // Not manual-on-failure: that disables the job, and one Vertex blip would
    // stop embedding backfill for good (issue #283).
    case 'embeddings_reconciler':
      return 'retry-safe'
    case 'share_inbox_cleanup': // Existing maintenance only; never replay uncertainty.
      return 'manual-on-failure'
    default:
      return 'blocked'
  }
}

export interface JobClaim {
  job: ScheduledJob
  token: string
  attempt: number
}

export function nextScheduledAt(schedule: string, now: number, initial = false): number | null {
  // Preserve overdue one-shot reminders on restart, but never repeat them.
  if (schedule.includes('T')) {
    const date = new Date(schedule).getTime()
    if (!Number.isFinite(date)) throw new Error('Invalid one-shot schedule')
    return initial ? date : null
  }
  const cron = new Cron(schedule, { paused: true })
  try {
    return cron.nextRun(new Date(now))?.getTime() ?? null
  } finally {
    cron.stop()
  }
}

export function initializeJobSchedule(job: ScheduledJob, now = Date.now()): void {
  const next = nextScheduledAt(job.schedule, now, true)
  // Older schedulers left completed one-shots enabled. Do not replay those
  // when introducing the durable cursor (or after a user toggles them on).
  const alreadyRan = job.schedule.includes('T') && next !== null
    && job.lastRunAt !== null && job.lastRunAt >= next
  getSqlite().prepare(`UPDATE scheduled_jobs SET next_run_at = ?,
    enabled = CASE WHEN ? THEN 0 ELSE enabled END
    WHERE id = ? AND user_id = ? AND schedule = ? AND next_run_at IS NULL AND run_state = 'idle'`)
    .run(next, alreadyRan || next === null ? 1 : 0, job.id, job.userId, job.schedule)
}

export function blockJob(id: string, userId: string, reason: string): void {
  getSqlite().prepare(`UPDATE scheduled_jobs SET enabled = 0, run_state = 'manual_recovery',
    last_error = ?, claim_token = NULL, claim_expires_at = NULL
    WHERE id = ? AND user_id = ?`).run(reason, id, userId)
}

// BEGIN IMMEDIATE serializes read/claim/recovery across SQLite connections.
// All completion writes are fenced by a fresh, unexpired token.
export function claimJob(id: string, userId: string, now = Date.now()): JobClaim | undefined {
  const sqlite = getSqlite()
  return sqlite.transaction(() => {
    const job = getJob(id, userId)
    if (!job?.enabled) return undefined
    const policy = getExecutionPolicy(job.type)
    if (policy === 'blocked') {
      blockJob(id, userId, `Autonomous execution blocked for job type: ${job.type}`)
      return undefined
    }
    const state = sqlite.prepare(`SELECT run_state AS state, next_run_at AS due,
      claim_expires_at AS expires, attempt_count AS attempts, retry_at AS retry
      FROM scheduled_jobs WHERE id = ? AND user_id = ?`).get(id, userId) as {
        state: string; due: number | null; expires: number | null; attempts: number; retry: number | null
      }
    if (!['idle', 'running', 'retry', 'manual_recovery'].includes(state.state)) {
      blockJob(id, userId, 'Manual recovery required: invalid persisted execution state')
      return undefined
    }
    if (state.state === 'manual_recovery' || state.due === null || state.due > now) return undefined
    if (state.state === 'running') {
      if (state.expires !== null && state.expires > now) return undefined
      if (policy !== 'retry-safe') {
        blockJob(id, userId, 'Manual recovery required: abandoned claim may have applied side effects')
        insertJobRun({ jobId: id, status: 'failed', error: 'Manual recovery required: abandoned claim' }, userId)
        return undefined
      }
    } else if (state.retry !== null && state.retry > now) {
      return undefined
    }
    if (state.attempts >= MAX_JOB_ATTEMPTS) {
      const next = nextScheduledAt(job.schedule, now)
      sqlite.prepare(`UPDATE scheduled_jobs SET run_state = 'idle', next_run_at = ?,
        enabled = ?, claim_token = NULL, claim_expires_at = NULL, retry_at = NULL,
        attempt_count = 0, last_error = 'Retry limit reached after abandoned claim'
        WHERE id = ? AND user_id = ?`).run(next, next === null ? 0 : 1, id, userId)
      insertJobRun({ jobId: id, status: 'failed', error: 'Retry limit reached after abandoned claim' }, userId)
      return undefined
    }
    const token = nanoid()
    sqlite.prepare(`UPDATE scheduled_jobs SET run_state = 'running', claim_token = ?,
      claim_expires_at = ?, attempt_count = attempt_count + 1, retry_at = NULL
      WHERE id = ? AND user_id = ?`).run(token, now + CLAIM_LEASE_MS, id, userId)
    return { job, token, attempt: state.attempts + 1 }
  }).immediate()
}

export function renewJobClaim(claim: JobClaim, now = Date.now()): boolean {
  return getSqlite().prepare(`UPDATE scheduled_jobs SET claim_expires_at = ?
    WHERE id = ? AND user_id = ? AND claim_token = ? AND run_state = 'running' AND claim_expires_at > ?`)
    .run(now + CLAIM_LEASE_MS, claim.job.id, claim.job.userId, claim.token, now).changes === 1
}

export function finishJobClaim(
  claim: JobClaim,
  outcome: { result?: JobRunResult | void; error?: string },
  now = Date.now(),
): boolean {
  const { job, token } = claim
  const sqlite = getSqlite()
  return sqlite.transaction(() => {
    const failed = outcome.error !== undefined
    const manual = failed && getExecutionPolicy(job.type) !== 'retry-safe'
    const retry = failed && !manual && claim.attempt < MAX_JOB_ATTEMPTS
    const next = retry || manual ? null : nextScheduledAt(job.schedule, now)
    const error = manual ? `Manual recovery required: ${outcome.error}` : outcome.error ?? null
    const changed = sqlite.prepare(`UPDATE scheduled_jobs SET
      run_state = ?, claim_token = NULL, claim_expires_at = NULL, last_error = ?,
      retry_at = ?, attempt_count = ?, next_run_at = CASE WHEN ? THEN next_run_at ELSE ? END,
      enabled = CASE WHEN ? THEN 0 ELSE enabled END,
      last_run_at = CASE WHEN ? THEN last_run_at ELSE ? END
      WHERE id = ? AND user_id = ? AND claim_token = ? AND run_state = 'running' AND claim_expires_at > ?`)
      .run(manual ? 'manual_recovery' : retry ? 'retry' : 'idle', error,
        retry ? now + RETRY_BASE_MS * 2 ** (claim.attempt - 1) : null, retry ? claim.attempt : 0,
        retry || manual ? 1 : 0, next, manual || (!retry && next === null) ? 1 : 0,
        failed ? 1 : 0, now, job.id, job.userId, token, now)
    if (changed.changes !== 1) return false
    insertJobRun({ jobId: job.id, status: failed ? 'failed' : 'success',
      suggestions: outcome.result?.suggestions, error: error ?? undefined }, job.userId)
    return true
  }).immediate()
}
