import { Router } from 'express'
import { z } from 'zod'
import { Cron } from 'croner'
import { getAllJobs, getJob, insertJob, updateJob, toggleJob, deleteJob, INTERNAL_JOB_TYPES, USER_JOB_TYPES } from '../../../jobs/store.js'
import { listJobTypes, getJobType } from '../../../jobs/registry.js'
import { addJobToScheduler, removeJobFromScheduler } from '../../../jobs/scheduler.js'
import { getRecentJobRuns, deleteAllJobRuns } from '../../../jobs/runStore.js'
import { getOutfit, getOutfitWithItems } from '../../../tools/outfits.js'
import type { OutfitSuggestion } from '../../../types/index.js'

const router = Router()

// z.any() for params — each job type validates its own params via paramsSchema
const CreateJobSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  schedule: z.string().min(1),
  params: z.any().optional(),
})

// GET /api/jobs — list all jobs; ?hydrate=true embeds outfit for outfit_reminder jobs
router.get('/', async (req, res) => {
  try {
    const userId = req.userId!
    const jobs = getAllJobs(userId)
      .filter(j => !INTERNAL_JOB_TYPES.has(j.type))
      .map(j => ({
        ...j,
        params: JSON.parse(j.params) as Record<string, unknown>,
      }))

    if (req.query.hydrate === 'true') {
      const hydrated = await Promise.all(
        jobs.map(async (job) => {
          if (job.type === 'outfit_reminder' && typeof job.params.outfitId === 'string') {
            const outfit = await getOutfit(job.params.outfitId, userId)
            return { ...job, outfit: outfit ?? null }
          }
          return { ...job, outfit: null }
        }),
      )
      return res.json(hydrated)
    }

    res.json(jobs)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/jobs/upcoming?days=7 — enabled jobs whose next fire falls within window
router.get('/upcoming', async (req, res) => {
  try {
    const userId = req.userId!
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10) || 7, 1), 30)
    const windowEnd = Date.now() + days * 24 * 60 * 60 * 1000
    const jobs = getAllJobs(userId).filter(j => j.enabled === 1 && !INTERNAL_JOB_TYPES.has(j.type))

    const results = await Promise.all(
      jobs.map(async (job) => {
        let nextRunAt: number | null = null
        try {
          const cron = new Cron(job.schedule)
          const next = cron.nextRun()
          if (next) nextRunAt = next.getTime()
          cron.stop()
        } catch {
          return null
        }
        if (!nextRunAt || nextRunAt > windowEnd) return null

        const base = {
          ...job,
          params: JSON.parse(job.params) as Record<string, unknown>,
          nextRunAt,
        }

        if (job.type === 'outfit_reminder' && typeof (base.params as Record<string, unknown>).outfitId === 'string') {
          const outfit = await getOutfit((base.params as Record<string, unknown>).outfitId as string, userId)
          return { ...base, outfit: outfit ?? null }
        }
        return { ...base, outfit: null }
      }),
    )

    res.json(results.filter(Boolean))
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/jobs/history?days=14 — recent job runs with parsed suggestions
router.get('/history', async (req, res) => {
  try {
    const userId = req.userId!
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90)
    const runs = getRecentJobRuns(days, userId)
    const allJobsAll = getAllJobs(userId)
    const internalJobIds = new Set(allJobsAll.filter(j => INTERNAL_JOB_TYPES.has(j.type)).map(j => j.id))
    const allJobs = allJobsAll.filter(j => !INTERNAL_JOB_TYPES.has(j.type))
    const jobMap = new Map(allJobs.map(j => [j.id, j]))
    const userRuns = runs.filter(r => !internalJobIds.has(r.jobId))

    const result = await Promise.all(userRuns.map(async run => {
      let suggestions: OutfitSuggestion[] = []
      try {
        if (run.resultJson) suggestions = JSON.parse(run.resultJson) as OutfitSuggestion[]
      } catch { /* malformed — ignore */ }

      const job = jobMap.get(run.jobId)
      const jobMeta = job ? { id: job.id, name: job.name, type: job.type } : null

      // For outfit_reminder: expose the source outfit id (for the "View outfit"
      // deep-link) and, only for legacy rows that predate durable resultJson,
      // rehydrate the outfit from job params. New runs carry the outfit snapshot
      // in resultJson, so they survive deletion of the source outfit.
      let reminderOutfit = null
      let reminderOutfitId: string | null = null
      if (job?.type === 'outfit_reminder') {
        try {
          const params = JSON.parse(job.params) as Record<string, unknown>
          if (typeof params.outfitId === 'string') {
            reminderOutfitId = params.outfitId
            if (suggestions.length === 0) {
              reminderOutfit = await getOutfitWithItems(params.outfitId, userId) ?? null
            }
          }
        } catch { /* non-fatal */ }
      }

      return { ...run, job: jobMeta, suggestions, reminderOutfit, reminderOutfitId }
    }))

    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/jobs/history — clear current user's job run history
router.delete('/history', (req, res) => {
  try {
    const userId = req.userId!
    deleteAllJobRuns(userId)
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/jobs/types — list available job types
router.get('/types', (_req, res) => {
  const types = listJobTypes().filter(jt => USER_JOB_TYPES.has(jt.key)).map(jt => ({
    key: jt.key,
    description: jt.description,
    scheduleHint: jt.scheduleHint,
  }))
  res.json(types)
})

// GET /api/jobs/:id
router.get('/:id', (req, res) => {
  const userId = req.userId!
  const job = getJob(req.params.id, userId)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json({ ...job, params: JSON.parse(job.params) })
})

// POST /api/jobs — create a new job
router.post('/', async (req, res) => {
  try {
    const userId = req.userId!
    const body = CreateJobSchema.safeParse(req.body)
    if (!body.success) return res.status(400).json({ error: body.error.flatten() })

    const { name, type, schedule, params } = body.data

    const jobType = USER_JOB_TYPES.has(type) ? getJobType(type) : undefined
    if (!jobType) return res.status(400).json({ error: `Unknown job type: "${type}"` })

    const paramsValidation = jobType.paramsSchema.safeParse(params ?? {})
    if (!paramsValidation.success) {
      return res.status(400).json({ error: paramsValidation.error.flatten() })
    }

    const job = insertJob({ name, type, schedule, params: params ?? {}, userId })
    addJobToScheduler(job)
    res.status(201).json({ ...job, params: JSON.parse(job.params) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/jobs/:id — edit name, schedule, params
router.patch('/:id', (req, res) => {
  try {
    const userId = req.userId!
    const job = getJob(req.params.id, userId)
    if (!job) return res.status(404).json({ error: 'Job not found' })

    const body = z.object({
      name: z.string().min(1).optional(),
      schedule: z.string().min(1).optional(),
      params: z.any().optional(),
    }).safeParse(req.body)
    if (!body.success) return res.status(400).json({ error: body.error.flatten() })

    const updated = updateJob(req.params.id, body.data, userId)
    if (!updated) return res.status(409).json({ error: 'Job is running or awaiting recovery' })
    removeJobFromScheduler(req.params.id)
    if (updated?.enabled) addJobToScheduler(updated)
    res.json({ ...updated, params: JSON.parse(updated!.params) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/jobs/:id/toggle — enable or disable
router.patch('/:id/toggle', (req, res) => {
  const userId = req.userId!
  const job = getJob(req.params.id, userId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  const updated = toggleJob(req.params.id, job.enabled === 0, userId)
  if (!updated) return res.status(409).json({ error: 'Job requires manual recovery' })
  removeJobFromScheduler(req.params.id)
  if (updated?.enabled) addJobToScheduler(updated)
  res.json({ ...updated, params: JSON.parse(updated!.params) })
})

// DELETE /api/jobs/:id
router.delete('/:id', (req, res) => {
  const userId = req.userId!
  const job = getJob(req.params.id, userId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  removeJobFromScheduler(req.params.id)
  deleteJob(req.params.id, userId)
  res.status(204).send()
})

export default router
