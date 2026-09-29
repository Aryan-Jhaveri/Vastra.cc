import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { registerJobType, getJobType, listJobTypes } from '../../src/jobs/registry.js'
import type { JobType, JobContext } from '../../src/jobs/registry.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJobType(key: string, executeFn?: (params: unknown, ctx: JobContext) => Promise<void>): JobType {
  return {
    key,
    description: `Test job ${key}`,
    scheduleHint: '0 8 * * *',
    paramsSchema: z.object({ chatId: z.number() }),
    execute: executeFn ?? (async () => {}),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('job registry', () => {
  // Note: registry is a module-level Map, so registrations persist between tests.
  // We register unique keys per test to avoid collisions.

  it('registers and retrieves a job type by key', () => {
    const jt = makeJobType('test_retrieve')
    registerJobType(jt)
    expect(getJobType('test_retrieve')).toBe(jt)
  })

  it('getJobType returns undefined for unknown key', () => {
    expect(getJobType('does_not_exist')).toBeUndefined()
  })

  it('listJobTypes includes all registered types', () => {
    registerJobType(makeJobType('test_list_a'))
    registerJobType(makeJobType('test_list_b'))

    const keys = listJobTypes().map(jt => jt.key)
    expect(keys).toContain('test_list_a')
    expect(keys).toContain('test_list_b')
  })

  it('re-registering a key overwrites the previous entry', () => {
    const v1 = makeJobType('test_overwrite')
    const v2 = makeJobType('test_overwrite')
    registerJobType(v1)
    registerJobType(v2)
    expect(getJobType('test_overwrite')).toBe(v2)
  })

  it('executes the handler with provided params and context', async () => {
    const received: { params: unknown; ctx: JobContext }[] = []

    const jt = makeJobType('test_execute', async (params, ctx) => {
      received.push({ params, ctx })
    })
    registerJobType(jt)

    const mockCtx = { botApi: {} } as unknown as JobContext
    await getJobType('test_execute')!.execute({ chatId: 42 }, mockCtx)

    expect(received).toHaveLength(1)
    expect(received[0].params).toEqual({ chatId: 42 })
    expect(received[0].ctx).toBe(mockCtx)
  })

  it('paramsSchema validates correct input', () => {
    registerJobType(makeJobType('test_schema'))
    const jt = getJobType('test_schema')!
    const result = jt.paramsSchema.safeParse({ chatId: 99 })
    expect(result.success).toBe(true)
  })

  it('paramsSchema rejects invalid input', () => {
    registerJobType(makeJobType('test_schema_fail'))
    const jt = getJobType('test_schema_fail')!
    const result = jt.paramsSchema.safeParse({ chatId: 'not-a-number' })
    expect(result.success).toBe(false)
  })
})
