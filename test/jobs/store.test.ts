import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/db/client.js', async () => {
  const { createJobDatabase } = await import('./fixtures.js')
  return createJobDatabase()
})

import { getSqlite } from '../../src/db/client.js'
import {
  getAllJobs, getEnabledJobs, getEnabledJobsForScheduler, getJob, insertJob,
  updateJob, updateJobLastRun, toggleJob, deleteJob,
} from '../../src/jobs/store.js'
import { blockJob, claimJob, initializeJobSchedule } from '../../src/jobs/claims.js'

beforeEach(() => getSqlite().exec('DELETE FROM scheduled_jobs; DELETE FROM job_runs'))

const create = (userId = 'user-a') => insertJob({
  userId, name: 'Morning Outfit', type: 'daily_outfit', schedule: '0 8 * * *',
})

describe('job store', () => {
  it('inserts, retrieves, updates, pauses, resumes and deletes owned jobs', () => {
    const job = create()
    expect(job).toMatchObject({ userId: 'user-a', params: '{}', lastRunAt: null, enabled: 1 })
    expect(getJob(job.id, 'user-a')?.name).toBe('Morning Outfit')
    expect(updateJob(job.id, { name: 'Renamed', params: { lat: 40 } }, 'user-a')?.name).toBe('Renamed')
    updateJobLastRun(job.id, 'user-a')
    expect(getJob(job.id, 'user-a')?.lastRunAt).toEqual(expect.any(Number))
    expect(toggleJob(job.id, false, 'user-a')?.enabled).toBe(0)
    expect(getEnabledJobs('user-a')).toEqual([])
    expect(getAllJobs('user-a')).toHaveLength(1)
    expect(toggleJob(job.id, true, 'user-a')?.enabled).toBe(1)
    deleteJob(job.id, 'user-a')
    expect(getJob(job.id, 'user-a')).toBeUndefined()
  })

  it('scopes every user-facing read and write, including missing userId at runtime', () => {
    const a = create()
    const b = create('user-b')
    expect(getAllJobs('user-a').map(j => j.id)).toEqual([a.id])
    expect(getEnabledJobs('user-b').map(j => j.id)).toEqual([b.id])
    expect(getEnabledJobsForScheduler()).toHaveLength(2)
    for (const other of ['user-b', '', undefined as unknown as string]) {
      expect(getJob(a.id, other)).toBeUndefined()
      expect(updateJob(a.id, { name: 'Hacked' }, other)).toBeUndefined()
      expect(toggleJob(a.id, false, other)).toBeUndefined()
      updateJobLastRun(a.id, other)
      deleteJob(a.id, other)
      expect(getAllJobs(other).some(j => j.id === a.id)).toBe(false)
    }
    expect(getJob(a.id, 'user-a')).toMatchObject({ name: 'Morning Outfit', enabled: 1, lastRunAt: null })
  })

  it('resets the durable cursor on a schedule edit and forbids edits during execution', () => {
    const job = create()
    initializeJobSchedule(job, 0)
    updateJob(job.id, { schedule: '0 9 * * *' }, job.userId)
    expect(getSqlite().prepare('SELECT next_run_at AS due FROM scheduled_jobs WHERE id = ?').get(job.id))
      .toEqual({ due: null })
    initializeJobSchedule(getJob(job.id, job.userId)!, 0)
    expect(claimJob(job.id, job.userId, Date.now())).toBeDefined()
    expect(updateJob(job.id, { name: 'Race' }, job.userId)).toBeUndefined()
  })

  it('does not let toggle or edit bypass manual recovery', () => {
    const job = create()
    blockJob(job.id, job.userId, 'Unknown outcome')
    expect(toggleJob(job.id, true, job.userId)).toBeUndefined()
    expect(updateJob(job.id, { schedule: '* * * * *' }, job.userId)).toBeUndefined()
    expect(getJob(job.id, job.userId)?.enabled).toBe(0)
  })
})
