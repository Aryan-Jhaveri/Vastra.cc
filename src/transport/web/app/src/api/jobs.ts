import { apiFetch, apiFetchJSON } from './client'
import type { Outfit, HydratedOutfit, OutfitSuggestion } from './outfits'

export interface ScheduledJob {
  id: string
  name: string
  type: string
  schedule: string
  params: Record<string, unknown>
  enabled: number
  lastRunAt: number | null
  createdAt: number
}

export interface UpcomingJob extends ScheduledJob {
  nextRunAt: number
  outfit: Outfit | null
}

export interface JobType {
  key: string
  description: string
  scheduleHint: string
}

export async function fetchJobs(): Promise<ScheduledJob[]> {
  return apiFetchJSON('/api/jobs')
}

export async function fetchJobTypes(): Promise<JobType[]> {
  return apiFetchJSON('/api/jobs/types')
}

export async function createJob(data: {
  name: string
  type: string
  schedule: string
  params?: Record<string, unknown>
}): Promise<ScheduledJob> {
  return apiFetchJSON('/api/jobs', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateJob(
  id: string,
  data: { name?: string; schedule?: string; params?: Record<string, unknown> },
): Promise<ScheduledJob> {
  return apiFetchJSON(`/api/jobs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function toggleJob(id: string): Promise<ScheduledJob> {
  return apiFetchJSON(`/api/jobs/${id}/toggle`, { method: 'PATCH' })
}

export async function deleteJob(id: string): Promise<void> {
  await apiFetch(`/api/jobs/${id}`, { method: 'DELETE' })
}

export async function fetchUpcomingJobs(days = 7): Promise<UpcomingJob[]> {
  return apiFetchJSON(`/api/jobs/upcoming?days=${days}`)
}

export interface JobRun {
  id: string
  jobId: string
  firedAt: number
  status: 'success' | 'failed' | 'skipped'
  error?: string | null
  job: { id: string; name: string; type: string } | null
  suggestions: OutfitSuggestion[]
  reminderOutfit: HydratedOutfit | null
  reminderOutfitId: string | null
}

export async function fetchJobHistory(days = 14): Promise<JobRun[]> {
  return apiFetchJSON(`/api/jobs/history?days=${days}`)
}

export async function clearJobHistory(): Promise<void> {
  await apiFetch('/api/jobs/history', { method: 'DELETE' })
}
