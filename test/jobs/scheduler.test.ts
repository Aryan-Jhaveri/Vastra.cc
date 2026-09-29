import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

vi.mock('../../src/db/client.js', async () => {
  const { createJobDatabase } = await import('./fixtures.js')
  return createJobDatabase()
})
vi.mock('../../src/jobs/pushNotify.js', () => ({ sendJobNotification: vi.fn().mockResolvedValue(undefined) }))

import { getSqlite } from '../../src/db/client.js'
import { insertJob, getJob } from '../../src/jobs/store.js'
import { getJobRunsByJob } from '../../src/jobs/runStore.js'
import { registerJobType } from '../../src/jobs/registry.js'
import { sendJobNotification } from '../../src/jobs/pushNotify.js'
import { CLAIM_LEASE_MS, RETRY_BASE_MS, claimJob, initializeJobSchedule } from '../../src/jobs/claims.js'
import { runSchedulerTick, stopScheduler, initScheduler, addJobToScheduler } from '../../src/jobs/scheduler.js'

const execute = vi.fn()
const now = Date.parse('2026-09-19T10:00:00Z')
const create = (type = 'outfit_reminder', schedule = new Date(now).toISOString()) => insertJob({
  userId: 'user-a', name: 'Test Job', type, schedule, params: { outfitId: 'outfit-a' },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.clearAllMocks()
  execute.mockReset().mockResolvedValue({ suggestions: [] })
  getSqlite().exec('DELETE FROM scheduled_jobs; DELETE FROM job_runs')
  for (const key of ['outfit_reminder', 'share_inbox_cleanup', 'embeddings_reconciler', 'agent_tryon']) {
    registerJobType({ key, description: '', scheduleHint: '', paramsSchema: z.object({ outfitId: z.string() }), execute })
  }
})

afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
})

describe('durable scheduler', () => {
  it('executes once across overlapping ticks and never repeats a completed one-shot', async () => {
    const job = create()
    let resolve!: (value: { suggestions: [] }) => void
    execute.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const first = runSchedulerTick()
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    resolve({ suggestions: [] })
    await first
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ outfitId: 'outfit-a' }, { jobId: job.id, userId: 'user-a' })
    expect(getJob(job.id, job.userId)).toMatchObject({ enabled: 0, lastRunAt: now })
    expect(getJobRunsByJob(job.id, job.userId)).toHaveLength(1)
    expect(sendJobNotification).toHaveBeenCalledWith('Test Job', [], 'user-a')
  })

  it('recovers abandoned safe claims after restart, but not while their lease is live', async () => {
    const job = create()
    initializeJobSchedule(job)
    expect(claimJob(job.id, job.userId)).toBeDefined()
    stopScheduler()
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    vi.setSystemTime(now + CLAIM_LEASE_MS)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(getJobRunsByJob(job.id, job.userId)[0].status).toBe('success')
  })

  it('does not replay already completed legacy one-shots after migration', async () => {
    const job = create()
    getSqlite().prepare('UPDATE scheduled_jobs SET last_run_at = ? WHERE id = ?').run(now, job.id)
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
  })

  it('catches up one overdue recurring occurrence after downtime without replaying every missed slot', async () => {
    const job = create('outfit_reminder', '* * * * *')
    addJobToScheduler(job)
    stopScheduler()
    vi.setSystemTime(now + 10 * 60_000)
    await runSchedulerTick()
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 11 * 60_000)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('persists exponential backoff across restart and stops after three failed attempts', async () => {
    const job = create()
    execute.mockRejectedValue(new Error('Temporary failure'))
    await runSchedulerTick()
    stopScheduler()
    vi.setSystemTime(now + RETRY_BASE_MS - 1)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + RETRY_BASE_MS)
    await runSchedulerTick()
    vi.setSystemTime(now + 3 * RETRY_BASE_MS - 1)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(2)
    vi.setSystemTime(now + 3 * RETRY_BASE_MS)
    await runSchedulerTick()
    vi.setSystemTime(now + 100 * CLAIM_LEASE_MS)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(3)
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
    expect(getJobRunsByJob(job.id, job.userId)).toHaveLength(3)
  })

  it('preserves recurring schedules after a successful occurrence', async () => {
    const job = create('outfit_reminder', '* * * * *')
    addJobToScheduler(job)
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    vi.setSystemTime(now + 60_000)
    await runSchedulerTick()
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 120_000)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(getJob(job.id, job.userId)?.enabled).toBe(1)
  })

  it.each(['agent_tryon', 'agent_mutation', 'tryon'])('blocks persisted %s without executing', async type => {
    const job = create(type)
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
    expect(getSqlite().prepare('SELECT run_state AS state FROM scheduled_jobs WHERE id = ?').get(job.id))
      .toEqual({ state: 'manual_recovery' })
  })

  it('executes the embeddings_reconciler job (retry-safe — issue #283)', async () => {
    // The reconciler only writes idempotent embedding upserts (derived data),
    // so it is safe to let the scheduler run it. This is the Layer-1 guarantee
    // that keeps Discover image mode fed with item image embeddings.
    const job = create('embeddings_reconciler')
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ outfitId: 'outfit-a' }, { jobId: job.id, userId: 'user-a' })
    expect(getJob(job.id, job.userId)?.enabled).toBe(0) // one-shot completed
    expect(getJobRunsByJob(job.id, job.userId)[0].status).toBe('success')
  })

  it('blocks invalid persisted params and schedules', async () => {
    const badParams = create()
    const badSchedule = create('outfit_reminder', 'not a cron')
    getSqlite().prepare('UPDATE scheduled_jobs SET params = ? WHERE id = ?').run('{broken', badParams.id)
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    expect(getJob(badParams.id, badParams.userId)?.enabled).toBe(0)
    expect(getJob(badSchedule.id, badSchedule.userId)?.enabled).toBe(0)
  })

  it('requires manual recovery after a mutating job error rather than retrying', async () => {
    const job = create('share_inbox_cleanup')
    execute.mockRejectedValue(new Error('Deleted some files before failure'))
    await runSchedulerTick()
    vi.setSystemTime(now + CLAIM_LEASE_MS * 10)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
    expect(getJobRunsByJob(job.id, job.userId)[0].error).toContain('Manual recovery required')
  })

  it('does not replay an abandoned mutating claim', async () => {
    const job = create('share_inbox_cleanup')
    initializeJobSchedule(job)
    expect(claimJob(job.id, job.userId)).toBeDefined()
    vi.setSystemTime(now + CLAIM_LEASE_MS)
    await runSchedulerTick()
    expect(execute).not.toHaveBeenCalled()
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
    expect(getJobRunsByJob(job.id, job.userId)[0].error).toContain('Manual recovery required')
  })

  it('renews leases while the executor is still running', async () => {
    const job = create()
    let resolve!: () => void
    execute.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const first = runSchedulerTick()
    await vi.advanceTimersByTimeAsync(CLAIM_LEASE_MS * 2)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    resolve()
    await first
    expect(getJobRunsByJob(job.id, job.userId)[0].status).toBe('success')
  })

  it('does not retry an executor when result persistence or push fails', async () => {
    const job = create('share_inbox_cleanup')
    getSqlite().exec("CREATE TRIGGER fail_history BEFORE INSERT ON job_runs BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runSchedulerTick()
      await runSchedulerTick()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(sendJobNotification).not.toHaveBeenCalled()
    } finally {
      getSqlite().exec('DROP TRIGGER fail_history')
      log.mockRestore()
    }
    vi.setSystemTime(now + CLAIM_LEASE_MS)
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)

    const safe = create()
    vi.mocked(sendJobNotification).mockRejectedValueOnce(new Error('push unavailable'))
    await runSchedulerTick()
    await runSchedulerTick()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(getJobRunsByJob(safe.id, safe.userId)[0].status).toBe('success')
  })

  it('initialization is idempotent and starts polling without Telegram', async () => {
    create()
    initScheduler()
    initScheduler()
    await vi.advanceTimersByTimeAsync(1000)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
