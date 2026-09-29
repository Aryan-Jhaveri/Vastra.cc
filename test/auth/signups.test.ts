import { afterEach, describe, expect, it } from 'vitest'
import { signupsOpen } from '../../src/auth/signups.js'

// #315 — who may create a new account. Self-host is closed unless opted in.
describe('signupsOpen', () => {
  const saved = { hosted: process.env.HOSTED_MODE, allow: process.env.ALLOW_SIGNUPS }
  afterEach(() => {
    for (const [key, value] of [['HOSTED_MODE', saved.hosted], ['ALLOW_SIGNUPS', saved.allow]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it.each([
    [undefined, undefined, false],
    [undefined, 'true', true],
    [undefined, 'TRUE ', true],
    [undefined, 'yes', false],
    ['true', undefined, true],
    ['true', 'false', false],
  ])('HOSTED_MODE=%s ALLOW_SIGNUPS=%s → %s', (hosted, allow, expected) => {
    if (hosted === undefined) delete process.env.HOSTED_MODE
    else process.env.HOSTED_MODE = hosted
    if (allow === undefined) delete process.env.ALLOW_SIGNUPS
    else process.env.ALLOW_SIGNUPS = allow
    expect(signupsOpen()).toBe(expected)
  })
})
