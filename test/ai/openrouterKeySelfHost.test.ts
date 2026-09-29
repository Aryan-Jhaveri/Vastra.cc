import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #315 — self-host has no per-user OpenRouter keys (nothing is minted at
// signup), so an OpenRouter-routed call uses the operator's key instead of
// failing with OpenRouterKeyMissingError. The hosted per-user key path is in
// test/hosted/ai/openrouterKey.test.ts.
const { insert } = vi.hoisted(() => ({ insert: vi.fn() }))
vi.mock('../../src/ai/aiCalls.js', () => ({ insertAiCall: insert }))

import { runInstrumented } from '../../src/ai/instrumented.js'
import { OpenRouterKeyMissingError } from '../../src/cost/errors.js'

const hosted = process.env.HOSTED_MODE
const input = (onKey: (key?: string) => void) => ({
  userId: 'alice', task: 'categorize' as const, model: 'mistralai/mistral-small-3.2-24b-instruct', expectedBilledTokens: 0,
  call: async ({ openrouterKey }: { openrouterKey?: string }) => { onKey(openrouterKey); return { result: 'ok' } },
})

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.HOSTED_MODE
})
afterEach(() => {
  vi.unstubAllEnvs()
  if (hosted === undefined) delete process.env.HOSTED_MODE
  else process.env.HOSTED_MODE = hosted
})

describe('OpenRouter key resolution', () => {
  it('self-host: uses the operator OPENROUTER_API_KEY and never looks up a per-user key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-operator')
    let used: string | undefined
    await expect(runInstrumented(input(k => { used = k }))).resolves.toBe('ok')
    expect(used).toBe('sk-or-operator')
  })

  it('self-host without an operator key fails closed with a setup hint', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const call = vi.fn()
    const err = await runInstrumented(input(call)).catch(e => e)
    expect(err).toBeInstanceOf(OpenRouterKeyMissingError)
    expect(err.message).toMatch(/set OPENROUTER_API_KEY/)
    expect(call).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ success: 0, userId: 'alice' }))
  })
})
