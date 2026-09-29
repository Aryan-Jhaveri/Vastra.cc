import { beforeAll, vi } from 'vitest'
import { hostedHooks, setHostedHooks } from '../../src/hostedHooks.js'

/**
 * Shared tests that sign users up / verify / delete them must not reach
 * OpenRouter's management API in the hosted run (.env may hold a real
 * management key). Keeps whatever hooks test/setup.ts registered and stubs the
 * two that mint or revoke keys. In the self-host run nothing is registered and
 * the stubs are never consulted. Call at module top level.
 */
export function quietHostedKeyHooks() {
  const onUserVerified = vi.fn()
  const beforeAccountDelete = vi.fn(async () => {})
  beforeAll(() => {
    setHostedHooks({ ...hostedHooks(), onUserVerified, beforeAccountDelete })
  })
  return { onUserVerified, beforeAccountDelete }
}
