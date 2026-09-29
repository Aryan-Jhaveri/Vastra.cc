import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/db/client.js', async () => {
  const { createJobDatabase } = await import('./fixtures.js')
  return createJobDatabase()
})

import { getSqlite } from '../../src/db/client.js'
import { insertJob, getJob } from '../../src/jobs/store.js'
import { getJobRunsByJob, deleteAllJobRuns } from '../../src/jobs/runStore.js'
import {
  claimJob, finishJobClaim, renewJobClaim, initializeJobSchedule, blockJob,
  CLAIM_LEASE_MS, MAX_JOB_ATTEMPTS,
} from '../../src/jobs/claims.js'
import { createJobDatabase } from './fixtures.js'

const now = Date.parse('2026-09-19T10:00:00Z')
function create() {
  const job = insertJob({ userId: 'user-a', name: 'Reminder', type: 'outfit_reminder', schedule: new Date(now).toISOString() })
  initializeJobSchedule(job, now)
  return job
}
beforeEach(() => getSqlite().exec('DELETE FROM scheduled_jobs; DELETE FROM job_runs'))

describe('durable claims', () => {
  it('fences a stale worker after lease recovery and commits only the new owner', () => {
    const job = create()
    const stale = claimJob(job.id, job.userId, now)!
    const fresh = claimJob(job.id, job.userId, now + CLAIM_LEASE_MS)!
    expect(fresh.token).not.toBe(stale.token)
    expect(fresh.attempt).toBe(2)
    expect(renewJobClaim(stale, now + CLAIM_LEASE_MS)).toBe(false)
    expect(finishJobClaim(stale, {}, now + CLAIM_LEASE_MS)).toBe(false)
    expect(finishJobClaim(fresh, {}, now + CLAIM_LEASE_MS)).toBe(true)
    expect(getJobRunsByJob(job.id, job.userId)).toHaveLength(1)
    deleteAllJobRuns(job.userId)
    expect(claimJob(job.id, job.userId, now + 2 * CLAIM_LEASE_MS)).toBeUndefined()
  })

  it('bounds attempts even when every worker dies without recording failure', () => {
    const job = create()
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
      expect(claimJob(job.id, job.userId, now + (attempt - 1) * CLAIM_LEASE_MS)?.attempt).toBe(attempt)
    }
    expect(claimJob(job.id, job.userId, now + MAX_JOB_ATTEMPTS * CLAIM_LEASE_MS)).toBeUndefined()
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
    expect(getJobRunsByJob(job.id, job.userId)[0].error).toContain('Retry limit')
  })

  it('rejects cross-user initialization, claims, renewal, completion and blocking', () => {
    const job = create()
    expect(claimJob(job.id, 'user-b', now)).toBeUndefined()
    blockJob(job.id, 'user-b', 'malicious block')
    initializeJobSchedule({ ...job, userId: 'user-b' }, now)
    const claim = claimJob(job.id, job.userId, now)!
    const forged = { ...claim, job: { ...job, userId: 'user-b' } }
    expect(renewJobClaim(forged, now)).toBe(false)
    expect(finishJobClaim(forged, {}, now)).toBe(false)
    expect(finishJobClaim(claim, {}, now)).toBe(true)
    expect(getJobRunsByJob(job.id, 'user-b')).toEqual([])
    expect(getJobRunsByJob(job.id, job.userId)).toHaveLength(1)
  })

  it('allows only one claim across independent worker processes and connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'closet-claims-'))
    const { getSqlite: connection } = createJobDatabase(join(dir, 'closet.db'))
    connection().prepare(`INSERT INTO scheduled_jobs
      (id, user_id, name, type, schedule, created_at, next_run_at)
      VALUES ('race', 'user-a', 'Race', 'outfit_reminder', ?, ?, ?)`).run(new Date(now).toISOString(), now, now)
    connection().close()
    const worker = fileURLToPath(new URL('./claimWorker.ts', import.meta.url))
    const run = () => new Promise<unknown>((resolve, reject) => {
      const child = fork(worker, ['race', String(now)], {
        execArgv: ['--import', 'tsx'], env: { ...process.env, CLOSET_DATA_DIR: dir }, silent: true,
      })
      let message: unknown
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('message', value => { message = value })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve(message) : reject(new Error(stderr)))
    })
    try {
      const results = await Promise.all([run(), run(), run(), run()])
      expect(results.filter(value => typeof value === 'string')).toHaveLength(1)
      expect(results.filter(value => value === null)).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
