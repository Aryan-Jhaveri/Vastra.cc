import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// OSS audit 2026-09-28 — wrong admin-fallback tokens are counted per IP; past
// the limit, fallback tokens from that IP aren't compared at all.

vi.mock('../../../src/db/queries.js', () => ({
  getSystemSetting: vi.fn().mockReturnValue(null), setSystemSetting: vi.fn(),
  getSessionByToken: vi.fn().mockReturnValue(undefined), isUserAdmin: vi.fn().mockReturnValue(false),
  getUserById: vi.fn(), getApiTokenByPlaintext: vi.fn(), touchApiToken: vi.fn(),
}))

const saved = { fb: process.env.ADMIN_BEARER_FALLBACK, pw: process.env.WEB_AUTH_PASSWORD }
beforeEach(() => {
  vi.resetModules()
  process.env.ADMIN_BEARER_FALLBACK = 'true'
  process.env.WEB_AUTH_PASSWORD = 'correct horse battery staple'
})
afterEach(() => {
  for (const [k, v] of [['ADMIN_BEARER_FALLBACK', saved.fb], ['WEB_AUTH_PASSWORD', saved.pw]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('matchesAdminFallback', () => {
  it('locks out an IP after 20 wrong tokens, even for the right one; other IPs and the next window are fine', async () => {
    const m = await import('../../../src/transport/web/middleware.js')
    const good = m.sessionToken('correct horse battery staple')
    const t0 = 1_000_000
    expect(m.matchesAdminFallback(good, '198.51.100.1', t0)).toBe(true)
    for (let i = 0; i < 20; i++) expect(m.matchesAdminFallback(m.sessionToken(`guess-${i}`), '198.51.100.1', t0)).toBe(false)
    expect(m.matchesAdminFallback(good, '198.51.100.1', t0)).toBe(false)
    expect(m.matchesAdminFallback(good, '198.51.100.2', t0)).toBe(true)
    expect(m.matchesAdminFallback(good, '198.51.100.1', t0 + 15 * 60_000 + 1)).toBe(true)
  })

  it('is off unless ADMIN_BEARER_FALLBACK=true', async () => {
    process.env.ADMIN_BEARER_FALLBACK = 'false'
    const m = await import('../../../src/transport/web/middleware.js')
    expect(m.matchesAdminFallback(m.sessionToken('correct horse battery staple'), '198.51.100.3')).toBe(false)
  })
})
