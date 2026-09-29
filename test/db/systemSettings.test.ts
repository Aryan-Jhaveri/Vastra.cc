import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'

// getSystemSetting/setSystemSetting bind to the client-scoped db
// (src/db/client.ts). test/setup.ts imports that client before any test
// file's hooks run, so by the time this file executes the module is already
// bound to the per-run CLOSET_DATA_DIR from vitest.config.ts —
// a per-file env override would come too late (the previous mkdtemp-based
// setup never actually took effect; it only appeared to work).
//
// The suite shares that db across files AND across runs, so this file must not
// leave its __system__ row behind: a leftover 'password' row made the first
// assertion fail on any run that started with the residue (order-dependent
// under --sequence.shuffle, and eventually in-order too). Clear the row on
// both ends so this test is independent of db history and later files see a
// clean db (#301).
import { db } from '../../src/db/client.js'
import { settings } from '../../src/db/schema.js'
import { getSystemSetting, setSystemSetting, getSetting } from '../../src/db/queries.js'

function clearSystemPasswordRow(): void {
  db.delete(settings)
    .where(and(eq(settings.key, 'password'), eq(settings.userId, '__system__')))
    .run()
}

beforeAll(() => {
  clearSystemPasswordRow()
})

afterAll(() => {
  clearSystemPasswordRow()
})

describe('system settings helpers', () => {
  it('round-trips a system global and keeps it out of per-user reads', () => {
    expect(getSystemSetting('password')).toBeNull()

    setSystemSetting('password', 'admin-secret')
    expect(getSystemSetting('password')).toBe('admin-secret')

    // The per-user reader must never surface the reserved __system__ row.
    expect(getSetting('password', 'regular-user-123')).toBeNull()

    // setSystemSetting upserts in place (idempotent rotation).
    setSystemSetting('password', 'rotated-secret')
    expect(getSystemSetting('password')).toBe('rotated-secret')
  })
})
