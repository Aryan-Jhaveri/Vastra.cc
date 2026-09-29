import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBilling, hostedHooks, resetHostedHooks, SELF_HOST_HOOKS, setHostedHooks, type HostedHooks } from '../src/hostedHooks.js'
import { noopBilling } from '../src/cost/billing.js'
import { OpenRouterKeyMissingError } from '../src/cost/errors.js'

// #358 — shared code reaches the hosted extras only through these hooks. The
// hosted set itself is tested in test/hosted/hostedHooks.test.ts.

const hosted = process.env.HOSTED_MODE
// What test/setup.ts registered (hosted run only), restored after each test.
let registered: HostedHooks | null = null

beforeAll(() => {
  registered = hosted === 'true' ? hostedHooks() : null
})
beforeEach(() => resetHostedHooks())
afterEach(() => {
  vi.unstubAllEnvs()
  if (hosted === undefined) delete process.env.HOSTED_MODE
  else process.env.HOSTED_MODE = hosted
  if (registered) setHostedHooks(registered)
  else resetHostedHooks()
})

describe('self-host defaults (nothing registered)', () => {
  it('billing is the no-op: unlimited balance, no reservation', () => {
    expect(getBilling()).toBe(noopBilling)
    expect(getBilling().balance('u')).toBe(Number.POSITIVE_INFINITY)
    expect(getBilling().canSpend('u', 16)).toBeNull()
  })

  it('OpenRouter calls use the operator key, and fail closed without one', () => {
    vi.stubEnv('OPENROUTER_API_KEY', ' sk-or-operator ')
    expect(hostedHooks().resolveOpenRouterKey('u')).toBe('sk-or-operator')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    expect(() => hostedHooks().resolveOpenRouterKey('u')).toThrow(OpenRouterKeyMissingError)
    expect(() => hostedHooks().resolveOpenRouterKey('u')).toThrow(/OPENROUTER_API_KEY/)
  })

  it('lifecycle hooks do nothing and no hosted jobs or boot checks exist', async () => {
    const hooks = hostedHooks()
    expect(hooks).toBe(SELF_HOST_HOOKS)
    expect(() => hooks.onUserCreated({} as never, 'u')).not.toThrow()
    expect(() => hooks.onUserVerified('u')).not.toThrow()
    await expect(hooks.beforeAccountDelete('u')).resolves.toBeUndefined()
    expect(hooks.jobTypes).toEqual([])
    expect(hooks.bootChecks).toEqual([])
  })
})

describe('registered hooks', () => {
  const custom: HostedHooks = { ...SELF_HOST_HOOKS, jobTypes: [{ key: 'x' } as never] }

  it('apply only while HOSTED_MODE is on', () => {
    setHostedHooks(custom)
    process.env.HOSTED_MODE = 'true'
    expect(hostedHooks()).toBe(custom)
    delete process.env.HOSTED_MODE
    expect(hostedHooks()).toBe(SELF_HOST_HOOKS)
  })
})
