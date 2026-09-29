import { getEnabledJobsForScheduler, type ScheduledJob } from './store.js'
import { sendJobNotification } from './pushNotify.js'
import { getJobType, type JobRunResult } from './registry.js'
import {
  blockJob, claimJob, finishJobClaim, getExecutionPolicy, initializeJobSchedule,
  renewJobClaim, CLAIM_LEASE_MS,
} from './claims.js'

let timer: ReturnType<typeof setInterval> | undefined
const activeJobs = new Set<string>()

/** Each tick reads fresh rows; the DB, not local timers, owns the schedule. */
export async function runSchedulerTick(): Promise<void> {
  const jobs = getEnabledJobsForScheduler()
  await Promise.all(jobs.map(async job => {
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const jobType = getJobType(job.type)
      if (!jobType || getExecutionPolicy(job.type) === 'blocked') {
        blockJob(job.id, job.userId, `Autonomous execution blocked for job type: ${job.type}`)
        activeJobs.delete(job.id)
        return
      }
      // Persisted rows are untrusted, including rows written outside the API.
      try {
        jobType.paramsSchema.parse(JSON.parse(job.params))
        initializeJobSchedule(job)
      } catch (err) {
        blockJob(job.id, job.userId, `Invalid scheduled job: ${String(err)}`)
        activeJobs.delete(job.id)
        return
      }
      activeJobs.add(job.id)
      const claim = claimJob(job.id, job.userId)
      if (!claim) return
      // Validate again against the freshly claimed row, not a stale tick snapshot.
      const executor = getJobType(claim.job.type)
      if (!executor || getExecutionPolicy(claim.job.type) === 'blocked') {
        blockJob(job.id, job.userId, 'Autonomous execution blocked after claim')
        return
      }
      let lostClaim = false
      heartbeat = setInterval(() => {
        try {
          if (!renewJobClaim(claim)) lostClaim = true
        } catch {
          lostClaim = true
        }
      }, CLAIM_LEASE_MS / 3)
      heartbeat.unref()
      let result: JobRunResult | void = undefined
      let error: string | undefined
      try {
        const params = executor.paramsSchema.parse(JSON.parse(claim.job.params))
        result = await executor.execute(params, { jobId: job.id, userId: job.userId })
      } catch (err) {
        error = String(err)
      }
      // A persistence error is NOT an executor failure. Leave the durable claim
      // for recovery, rather than accidentally replaying a side effect.
      if (!lostClaim && finishJobClaim(claim, { result, error }) && error === undefined) {
        // Best effort after the fenced commit; never retry execution for push.
        void sendJobNotification(job.name, result?.suggestions ?? [], job.userId).catch(() => {})
      }
    } catch (err) {
      console.error(`[scheduler] Job ${job.id} failed:`, err)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }
  }))
}

export function initScheduler(): void {
  if (timer) return
  const tick = () => void runSchedulerTick().catch(err => console.error('[scheduler] Tick failed:', err))
  tick()
  timer = setInterval(tick, 1000)
  timer.unref()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  activeJobs.clear()
}

export function addJobToScheduler(job: ScheduledJob): void {
  if (!getJobType(job.type) || getExecutionPolicy(job.type) === 'blocked') {
    blockJob(job.id, job.userId, `Autonomous execution blocked for job type: ${job.type}`)
    return
  }
  initializeJobSchedule(job)
  activeJobs.add(job.id)
}

// Callers persist edits/toggles/deletes themselves; the next tick observes them.
export function removeJobFromScheduler(jobId: string): void {
  activeJobs.delete(jobId)
}

export function getActiveJobIds(): string[] {
  return Array.from(activeJobs)
}
