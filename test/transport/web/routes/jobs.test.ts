import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// ── Mock store and registry ───────────────────────────────────────────────────

vi.mock('../../../../src/jobs/store.js', () => ({
  getAllJobs: vi.fn(),
  getJob: vi.fn(),
  insertJob: vi.fn(),
  toggleJob: vi.fn(),
  deleteJob: vi.fn(),
  updateJob: vi.fn(),
  INTERNAL_JOB_TYPES: new Set(['openrouter_spend_reconciler', 'share_inbox_cleanup', 'embeddings_reconciler']),
  USER_JOB_TYPES: new Set(['daily_outfit', 'outfit_reminder']),
}))

vi.mock('../../../../src/jobs/registry.js', () => ({
  listJobTypes: vi.fn(),
  getJobType: vi.fn(),
}))

vi.mock('../../../../src/jobs/scheduler.js', () => ({
  addJobToScheduler: vi.fn(),
  removeJobFromScheduler: vi.fn(),
}))


vi.mock('../../../../src/tools/outfits.js', () => ({
  getOutfit: vi.fn(),
  getOutfitWithItems: vi.fn(),
}))

vi.mock('../../../../src/jobs/runStore.js', () => ({
  getRecentJobRuns: vi.fn(),
  deleteAllJobRuns: vi.fn(),
}))

import * as store from '../../../../src/jobs/store.js'
import * as registry from '../../../../src/jobs/registry.js'
import * as scheduler from '../../../../src/jobs/scheduler.js'
import * as runStore from '../../../../src/jobs/runStore.js'
import * as outfitTools from '../../../../src/tools/outfits.js'
import jobsRouter from '../../../../src/transport/web/routes/jobs.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', jobsRouter)
  return app
}

const mockJob = {
  id: 'job-1',
  name: 'Morning Outfit',
  type: 'daily_outfit',
  schedule: '0 8 * * *',
  params: '{"chatId":123,"lat":43.7,"lon":-79.4,"locationName":"Toronto"}',
  enabled: 1,
  lastRunAt: null,
  createdAt: Date.now(),
}

const mockJobType = {
  key: 'daily_outfit',
  description: 'Daily outfit suggestion',
  scheduleHint: '0 8 * * *',
  paramsSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
  execute: vi.fn(),
}

describe('GET /', () => {
  it('returns all jobs with params parsed', async () => {
    vi.mocked(store.getAllJobs).mockReturnValue([mockJob] as ReturnType<typeof store.getAllJobs>)

    const res = await request(makeApp()).get('/')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('job-1')
    expect(res.body[0].params.locationName).toBe('Toronto')
  })
})

describe('GET /types', () => {
  it('returns job type list', async () => {
    vi.mocked(registry.listJobTypes).mockReturnValue([mockJobType] as ReturnType<typeof registry.listJobTypes>)

    const res = await request(makeApp()).get('/types')
    expect(res.status).toBe(200)
    expect(res.body[0].key).toBe('daily_outfit')
    expect(res.body[0].scheduleHint).toBe('0 8 * * *')
  })

  it('hides internal system job types', async () => {
    vi.mocked(registry.listJobTypes).mockReturnValue([
      mockJobType,
      { ...mockJobType, key: 'embeddings_reconciler' },
      { ...mockJobType, key: 'share_inbox_cleanup' },
    ] as ReturnType<typeof registry.listJobTypes>)

    const res = await request(makeApp()).get('/types')
    expect(res.body.map((t: { key: string }) => t.key)).toEqual(['daily_outfit'])
  })
})

describe('GET /:id', () => {
  it('returns job by id', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)

    const res = await request(makeApp()).get('/job-1')
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Morning Outfit')
  })

  it('returns 404 for unknown id', async () => {
    vi.mocked(store.getJob).mockReturnValue(undefined)

    const res = await request(makeApp()).get('/nonexistent')
    expect(res.status).toBe(404)
  })
})

describe('POST /', () => {
  beforeEach(() => {
    // Clear history first: "calls addJobToScheduler with the new job" also
    // triggers insertJob, so without this its calls pile onto the count and
    // "creates a job" sees 2 when shuffle runs it later (#301).
    vi.clearAllMocks()
    vi.mocked(registry.getJobType).mockReturnValue(mockJobType as ReturnType<typeof registry.getJobType>)
    vi.mocked(store.insertJob).mockReturnValue(mockJob as ReturnType<typeof store.insertJob>)
    mockJobType.paramsSchema.safeParse = vi.fn(() => ({ success: true, data: {} }))
    vi.mocked(scheduler.addJobToScheduler).mockReset()
  })

  it('creates a job and returns 201', async () => {
    const res = await request(makeApp())
      .post('/')
      .send({ name: 'Morning Outfit', type: 'daily_outfit', schedule: '0 8 * * *', params: { chatId: 123 } })

    if (res.status === 500) throw new Error(`Unexpected 500: ${JSON.stringify(res.body)}`)
    expect(res.status).toBe(201)
    expect(store.insertJob).toHaveBeenCalledOnce()
  })

  it('calls addJobToScheduler with the new job', async () => {
    await request(makeApp())
      .post('/')
      .send({ name: 'Morning Outfit', type: 'daily_outfit', schedule: '0 8 * * *', params: { chatId: 123 } })

    expect(scheduler.addJobToScheduler).toHaveBeenCalledOnce()
    expect(scheduler.addJobToScheduler).toHaveBeenCalledWith(mockJob)
  })

  it('returns 400 for missing required fields', async () => {
    const res = await request(makeApp()).post('/').send({ name: 'Missing type' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for unknown job type', async () => {
    vi.mocked(registry.getJobType).mockReturnValue(undefined)
    const res = await request(makeApp())
      .post('/')
      .send({ name: 'X', type: 'unknown_type', schedule: '0 8 * * *' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Unknown job type/)
  })

  it.each(['embeddings_reconciler', 'openrouter_spend_reconciler', 'share_inbox_cleanup'])(
    'rejects registered system job type %s', async (type) => {
      // Registered in the registry, but not user-creatable.
      vi.mocked(store.insertJob).mockClear()
      const res = await request(makeApp())
        .post('/')
        .send({ name: 'X', type, schedule: '* * * * *' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Unknown job type/)
      expect(store.insertJob).not.toHaveBeenCalled()
      expect(scheduler.addJobToScheduler).not.toHaveBeenCalled()
    },
  )

  it('returns 400 when params fail schema validation', async () => {
    mockJobType.paramsSchema.safeParse = vi.fn(() => ({
      success: false,
      error: { flatten: () => ({ fieldErrors: { chatId: ['Required'] } }) },
    }))
    const res = await request(makeApp())
      .post('/')
      .send({ name: 'X', type: 'daily_outfit', schedule: '0 8 * * *' })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /:id/toggle', () => {
  beforeEach(() => {
    vi.mocked(scheduler.addJobToScheduler).mockReset()
    vi.mocked(scheduler.removeJobFromScheduler).mockReset()
  })

  it('toggles job enabled state', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.toggleJob).mockReturnValue({ ...mockJob, enabled: 0 } as ReturnType<typeof store.toggleJob>)

    const res = await request(makeApp()).patch('/job-1/toggle')
    expect(res.status).toBe(200)
    expect(res.body.enabled).toBe(0)
    expect(store.toggleJob).toHaveBeenCalledWith('job-1', false, undefined)
  })

  it('removes job from scheduler on toggle', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.toggleJob).mockReturnValue({ ...mockJob, enabled: 0 } as ReturnType<typeof store.toggleJob>)

    await request(makeApp()).patch('/job-1/toggle')
    expect(scheduler.removeJobFromScheduler).toHaveBeenCalledWith('job-1')
  })

  it('re-adds job to scheduler when enabling', async () => {
    const disabledJob = { ...mockJob, enabled: 0 }
    vi.mocked(store.getJob).mockReturnValue(disabledJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.toggleJob).mockReturnValue({ ...mockJob, enabled: 1 } as ReturnType<typeof store.toggleJob>)

    await request(makeApp()).patch('/job-1/toggle')
    expect(scheduler.addJobToScheduler).toHaveBeenCalledOnce()
  })

  it('does not re-add job to scheduler when disabling', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.toggleJob).mockReturnValue({ ...mockJob, enabled: 0 } as ReturnType<typeof store.toggleJob>)

    await request(makeApp()).patch('/job-1/toggle')
    expect(scheduler.addJobToScheduler).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown job', async () => {
    vi.mocked(store.getJob).mockReturnValue(undefined)
    const res = await request(makeApp()).patch('/ghost/toggle')
    expect(res.status).toBe(404)
  })
})

describe('PATCH /:id (edit)', () => {
  beforeEach(() => {
    vi.mocked(scheduler.addJobToScheduler).mockReset()
    vi.mocked(scheduler.removeJobFromScheduler).mockReset()
  })

  it('updates job fields', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.updateJob).mockReturnValue({ ...mockJob, name: 'Evening Job' } as ReturnType<typeof store.updateJob>)

    const res = await request(makeApp())
      .patch('/job-1')
      .send({ name: 'Evening Job', schedule: '0 20 * * *' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Evening Job')
  })

  it('reschedules job in scheduler on update (remove + re-add)', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.updateJob).mockReturnValue({ ...mockJob, schedule: '0 20 * * *' } as ReturnType<typeof store.updateJob>)

    await request(makeApp()).patch('/job-1').send({ schedule: '0 20 * * *' })
    expect(scheduler.removeJobFromScheduler).toHaveBeenCalledWith('job-1')
    expect(scheduler.addJobToScheduler).toHaveBeenCalledOnce()
  })

  it('does not re-add disabled job on update', async () => {
    const disabledJob = { ...mockJob, enabled: 0 }
    vi.mocked(store.getJob).mockReturnValue(disabledJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.updateJob).mockReturnValue(disabledJob as ReturnType<typeof store.updateJob>)

    await request(makeApp()).patch('/job-1').send({ name: 'New Name' })
    expect(scheduler.removeJobFromScheduler).toHaveBeenCalledWith('job-1')
    expect(scheduler.addJobToScheduler).not.toHaveBeenCalled()
  })

  it('returns 404 for unknown job', async () => {
    vi.mocked(store.getJob).mockReturnValue(undefined)
    const res = await request(makeApp()).patch('/ghost').send({ name: 'X' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:id', () => {
  beforeEach(() => {
    vi.mocked(scheduler.removeJobFromScheduler).mockReset()
  })

  it('deletes a job and returns 204', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.deleteJob).mockReturnValue(undefined)

    const res = await request(makeApp()).delete('/job-1')
    expect(res.status).toBe(204)
    expect(store.deleteJob).toHaveBeenCalledWith('job-1', undefined)
  })

  it('removes job from scheduler on delete', async () => {
    vi.mocked(store.getJob).mockReturnValue(mockJob as ReturnType<typeof store.getJob>)
    vi.mocked(store.deleteJob).mockReturnValue(undefined)

    await request(makeApp()).delete('/job-1')
    expect(scheduler.removeJobFromScheduler).toHaveBeenCalledWith('job-1')
  })

  it('returns 404 for unknown job', async () => {
    vi.mocked(store.getJob).mockReturnValue(undefined)
    const res = await request(makeApp()).delete('/ghost')
    expect(res.status).toBe(404)
  })
})

describe('GET /?hydrate=true', () => {
  const mockOutfitReminderJob = {
    id: 'job-2',
    name: 'Wear Summer Vibes',
    type: 'outfit_reminder',
    schedule: '0 8 * * 1',
    params: '{"chatId":"123","outfitId":"outfit-1"}',
    enabled: 1,
    lastRunAt: null,
    createdAt: Date.now(),
  }

  const mockOutfit = {
    id: 'outfit-1',
    name: 'Summer Vibes',
    coverImageUri: null,
    itemIds: '[]',
    occasion: 'casual',
  }

  it('embeds outfit for outfit_reminder jobs', async () => {
    vi.mocked(store.getAllJobs).mockReturnValue([mockOutfitReminderJob] as ReturnType<typeof store.getAllJobs>)
    vi.mocked(outfitTools.getOutfit).mockResolvedValue(mockOutfit as ReturnType<typeof outfitTools.getOutfit> extends Promise<infer T> ? T : never)

    const res = await request(makeApp()).get('/?hydrate=true')
    expect(res.status).toBe(200)
    expect(res.body[0].outfit).toBeTruthy()
    expect(res.body[0].outfit.id).toBe('outfit-1')
  })

  it('sets outfit: null for daily_outfit jobs', async () => {
    vi.mocked(store.getAllJobs).mockReturnValue([mockJob] as ReturnType<typeof store.getAllJobs>)

    const res = await request(makeApp()).get('/?hydrate=true')
    expect(res.status).toBe(200)
    expect(res.body[0].outfit).toBeNull()
  })

  it('sets outfit: null when outfit_reminder outfit is deleted', async () => {
    vi.mocked(store.getAllJobs).mockReturnValue([mockOutfitReminderJob] as ReturnType<typeof store.getAllJobs>)
    vi.mocked(outfitTools.getOutfit).mockResolvedValue(undefined)

    const res = await request(makeApp()).get('/?hydrate=true')
    expect(res.status).toBe(200)
    expect(res.body[0].outfit).toBeNull()
  })
})

describe('GET /history', () => {
  const mockRun = {
    id: 'run-1',
    userId: 'self',
    jobId: 'job-1',
    firedAt: Date.now(),
    status: 'success',
    resultJson: JSON.stringify([{ name: 'Cool outfit', item_ids: ['item-1'], reasoning: 'looks great' }]),
    error: null,
  }

  it('returns user-scoped job runs with suggestions parsed', async () => {
    vi.mocked(runStore.getRecentJobRuns).mockReturnValue([mockRun] as ReturnType<typeof runStore.getRecentJobRuns>)
    vi.mocked(store.getAllJobs).mockReturnValue([mockJob] as ReturnType<typeof store.getAllJobs>)

    const res = await request(makeApp()).get('/history?days=7')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('run-1')
    expect(res.body[0].suggestions[0].name).toBe('Cool outfit')
    expect(runStore.getRecentJobRuns).toHaveBeenCalledWith(7, undefined)
  })

  it('returns empty array when no runs exist', async () => {
    vi.mocked(runStore.getRecentJobRuns).mockReturnValue([])
    vi.mocked(store.getAllJobs).mockReturnValue([])

    const res = await request(makeApp()).get('/history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('DELETE /history', () => {
  it('deletes user-scoped job run history and returns 204', async () => {
    vi.mocked(runStore.deleteAllJobRuns).mockReturnValue(undefined)

    const res = await request(makeApp()).delete('/history')
    expect(res.status).toBe(204)
    expect(runStore.deleteAllJobRuns).toHaveBeenCalledWith(undefined)
  })
})

describe('GET /upcoming — one-off ISO schedule', () => {
  beforeEach(() => vi.clearAllMocks())

  it('includes a one-off ISO-dated job that fires within the window (croner native)', async () => {
    // +2 days keeps it inside the 7-day window and in the future regardless of
    // how croner interprets the timezone-less ISO literal.
    const isoSchedule = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19)
    const oneOff = { ...mockJob, id: 'oneoff-1', schedule: isoSchedule }
    vi.mocked(store.getAllJobs).mockReturnValue([oneOff] as ReturnType<typeof store.getAllJobs>)

    const res = await request(makeApp()).get('/upcoming?days=7')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].id).toBe('oneoff-1')
    expect(typeof res.body[0].nextRunAt).toBe('number')
    expect(res.body[0].nextRunAt).toBeGreaterThan(Date.now())
  })

  it('excludes a one-off whose ISO date is in the past', async () => {
    const pastIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19)
    const expired = { ...mockJob, id: 'expired-1', schedule: pastIso }
    vi.mocked(store.getAllJobs).mockReturnValue([expired] as ReturnType<typeof store.getAllJobs>)

    const res = await request(makeApp()).get('/upcoming?days=7')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('GET /history — durable outfit_reminder result', () => {
  beforeEach(() => vi.clearAllMocks())

  const reminderJob = {
    id: 'job-rem',
    name: 'Wear Summer Vibes',
    type: 'outfit_reminder',
    schedule: '0 8 * * 1',
    params: '{"outfitId":"outfit-9"}',
    enabled: 1,
    lastRunAt: null,
    createdAt: Date.now(),
  }

  const durableRun = {
    id: 'run-rem',
    userId: 'self',
    jobId: 'job-rem',
    firedAt: Date.now(),
    status: 'success',
    resultJson: JSON.stringify([{
      name: 'Summer Vibes',
      item_ids: ['item-1'],
      occasion: 'casual',
      reasoning: 'breezy',
      items: [{ id: 'item-1', imageUri: 'images/items/a.jpg' }],
    }]),
    error: null,
  }

  it('surfaces the reminder from resultJson even after the source outfit is deleted', async () => {
    vi.mocked(runStore.getRecentJobRuns).mockReturnValue([durableRun] as ReturnType<typeof runStore.getRecentJobRuns>)
    vi.mocked(store.getAllJobs).mockReturnValue([reminderJob] as ReturnType<typeof store.getAllJobs>)
    vi.mocked(outfitTools.getOutfitWithItems).mockResolvedValue(null) // outfit deleted

    const res = await request(makeApp()).get('/history?days=7')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].suggestions[0].name).toBe('Summer Vibes')
    expect(res.body[0].reminderOutfit).toBeNull()
    expect(res.body[0].reminderOutfitId).toBe('outfit-9')
    // resultJson is authoritative — rehydration is skipped, so the deleted
    // outfit is never looked up
    expect(outfitTools.getOutfitWithItems).not.toHaveBeenCalled()
  })

  it('falls back to rehydration for legacy rows without resultJson', async () => {
    const legacyRun = { ...durableRun, id: 'run-legacy', resultJson: null }
    const legacyOutfit = { id: 'outfit-9', name: 'Summer Vibes', itemIds: '[]', occasion: 'casual', notes: null, items: [] }
    vi.mocked(runStore.getRecentJobRuns).mockReturnValue([legacyRun] as ReturnType<typeof runStore.getRecentJobRuns>)
    vi.mocked(store.getAllJobs).mockReturnValue([reminderJob] as ReturnType<typeof store.getAllJobs>)
    vi.mocked(outfitTools.getOutfitWithItems).mockResolvedValue(
      legacyOutfit as ReturnType<typeof outfitTools.getOutfitWithItems> extends Promise<infer T> ? T : never,
    )

    const res = await request(makeApp()).get('/history?days=7')
    expect(res.status).toBe(200)
    expect(res.body[0].suggestions).toEqual([])
    expect(res.body[0].reminderOutfit).toBeTruthy()
    expect(res.body[0].reminderOutfitId).toBe('outfit-9')
    expect(outfitTools.getOutfitWithItems).toHaveBeenCalledWith('outfit-9', undefined)
  })
})
