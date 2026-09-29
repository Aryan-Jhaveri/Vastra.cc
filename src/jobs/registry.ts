import type { z } from 'zod'
import type { OutfitSuggestion } from '../types/index.js'

// Context passed to every job executor at runtime
export interface JobContext {
  jobId: string
  userId: string
}

// Optional result that executors can return to be stored in job_runs
export interface JobRunResult {
  suggestions?: OutfitSuggestion[]
  summary?: string
}

// Every registered job type implements this interface
export interface JobType<P = unknown> {
  key: string
  description: string
  // Human-readable schedule hint shown in /addjob conversation
  scheduleHint: string
  paramsSchema: z.ZodType<P>
  execute(params: P, ctx: JobContext): Promise<JobRunResult | void>
}

// Global registry — job types are registered at startup
const registry = new Map<string, JobType<unknown>>()

export function registerJobType<P>(jobType: JobType<P>): void {
  registry.set(jobType.key, jobType as JobType<unknown>)
}

export function getJobType(key: string): JobType<unknown> | undefined {
  return registry.get(key)
}

export function listJobTypes(): JobType<unknown>[] {
  return Array.from(registry.values())
}
