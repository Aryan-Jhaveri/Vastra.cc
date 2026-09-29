import { describe, it, expect, vi, afterEach } from 'vitest'

// client.ts reads GCP_PROJECT_ID at module load to pick vertex vs gemini, so
// each case stubs env then re-imports to exercise the routing branch.
// Note: OpenRouter routing is determined by model-id shape (slash) alone —
// the master key only gates whether requests can fall back to admin auth —
// so we don't need to vary OPENROUTER_API_KEY for routing assertions.
async function loadProviderForModel(env: Record<string, string | undefined>) {
  vi.resetModules()
  vi.stubEnv('OPENROUTER_API_KEY', env.OPENROUTER_API_KEY ?? '')
  vi.stubEnv('GCP_PROJECT_ID', env.GCP_PROJECT_ID ?? '')
  vi.stubEnv('GEMINI_API_KEY', env.GEMINI_API_KEY ?? 'test-key')
  const mod = await import('../../src/ai/client.js')
  return mod.providerForModel
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('providerForModel', () => {
  it('routes "vendor/model" ids to openrouter (per-user keys handle auth)', async () => {
    const providerForModel = await loadProviderForModel({ OPENROUTER_API_KEY: 'sk-or-test', GCP_PROJECT_ID: 'proj' })
    expect(providerForModel('mistralai/mistral-small-3.2-24b-instruct')).toBe('openrouter')
  })

  it('still routes slash-ids to openrouter even with no master key set', async () => {
    // Per #166, users get their own keys minted at signup. The slash-id shape
    // is the routing signal; the master key is only an admin/fallback for
    // resolving credentials, not a routing gate.
    const providerForModel = await loadProviderForModel({ GCP_PROJECT_ID: 'proj' })
    expect(providerForModel('mistralai/mistral-small-3.2-24b-instruct')).toBe('openrouter')
  })

  it('routes non-slash models to vertex when GCP_PROJECT_ID is set', async () => {
    const providerForModel = await loadProviderForModel({ GCP_PROJECT_ID: 'proj' })
    expect(providerForModel('gemini-2.5-flash')).toBe('vertex')
    expect(providerForModel('multimodalembedding@001')).toBe('vertex')
  })

  it('falls back to gemini (Developer API) when GCP_PROJECT_ID is unset', async () => {
    const providerForModel = await loadProviderForModel({})
    expect(providerForModel('gemini-2.5-flash')).toBe('gemini')
  })
})
