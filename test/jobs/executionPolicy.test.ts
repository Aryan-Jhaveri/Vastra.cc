import { describe, it, expect, afterEach } from 'vitest'
import { getExecutionPolicy } from '../../src/jobs/claims.js'

// #315 — the OpenRouter spend reconciler is a hosted-only job (it reconciles
// per-user key spend against the wallet). Self-host has neither, so any
// leftover row must be blocked rather than run pointlessly.

const originalHosted = process.env.HOSTED_MODE

describe('getExecutionPolicy — HOSTED_MODE gating (#315)', () => {
  afterEach(() => {
    if (originalHosted === undefined) delete process.env.HOSTED_MODE
    else process.env.HOSTED_MODE = originalHosted
  })

  it('openrouter_spend_reconciler is retry-safe in HOSTED_MODE', () => {
    process.env.HOSTED_MODE = 'true'
    expect(getExecutionPolicy('openrouter_spend_reconciler')).toBe('retry-safe')
  })

  it('openrouter_spend_reconciler is blocked when self-hosted', () => {
    delete process.env.HOSTED_MODE
    expect(getExecutionPolicy('openrouter_spend_reconciler')).toBe('blocked')
  })

  it('daily_outfit stays retry-safe in both modes (not billing-coupled)', () => {
    process.env.HOSTED_MODE = 'true'
    expect(getExecutionPolicy('daily_outfit')).toBe('retry-safe')
    delete process.env.HOSTED_MODE
    expect(getExecutionPolicy('daily_outfit')).toBe('retry-safe')
  })

  it('embeddings_reconciler stays retry-safe in both modes', () => {
    process.env.HOSTED_MODE = 'true'
    expect(getExecutionPolicy('embeddings_reconciler')).toBe('retry-safe')
    delete process.env.HOSTED_MODE
    expect(getExecutionPolicy('embeddings_reconciler')).toBe('retry-safe')
  })
})
