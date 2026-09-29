import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, and } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { users, settings } from '../src/db/schema.js'
import { setSetting } from '../src/db/queries.js'
import {
  getSettings,
  updateSettings,
  parseUserSizesPatch,
  parseStoredUserSizes,
  isSizesAgentContextEnabled,
} from '../src/settings.js'
import settingsRouter from '../src/transport/web/routes/settings.js'

// #329 — userSizes + sizesAgentContext in the per-user settings table, against
// the real DB so cross-user isolation and requireUserId are exercised for real.

const __dirname = dirname(fileURLToPath(import.meta.url))
const A = 'sizes-user-a'
const B = 'sizes-user-b'

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../src/db/migrations') })
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

beforeEach(() => {
  for (const key of ['userSizes', 'sizesAgentContext']) {
    db.delete(settings).where(eq(settings.key, key)).run()
  }
})

describe('getSettings / updateSettings require userId', () => {
  it('getSettings throws without a userId', () => {
    expect(() => getSettings(undefined as unknown as string)).toThrow(/userId is required/)
    expect(() => getSettings('')).toThrow(/userId is required/)
    expect(() => getSettings('   ')).toThrow(/userId is required/)
  })

  it('updateSettings throws without a userId and writes nothing', () => {
    expect(() => updateSettings({ userSizes: { tops: 'M' } }, undefined as unknown as string)).toThrow(/userId is required/)
    expect(() => updateSettings({ userSizes: { tops: 'M' } }, '')).toThrow(/userId is required/)
    const rows = db.select().from(settings).where(eq(settings.key, 'userSizes')).all()
    expect(rows).toHaveLength(0)
  })

  it('cross-user isolation: user B cannot read user A\'s sizes or toggle', () => {
    updateSettings({ userSizes: { tops: 'M', shoes: 'US 10' }, sizesAgentContext: false }, A)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M', shoes: 'US 10' })
    expect(getSettings(B).userSizes).toBeUndefined()
    expect(getSettings(B).sizesAgentContext).toBeUndefined()
    // B writing their own sizes doesn't touch A's.
    updateSettings({ userSizes: { tops: 'L' } }, B)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M', shoes: 'US 10' })
    expect(getSettings(B).userSizes).toEqual({ tops: 'L' })
  })
})

describe('userSizes storage', () => {
  it('saves trimmed values for valid categories', () => {
    const res = updateSettings({ userSizes: { tops: '  M ', bottoms: '32 × 30' } }, A)
    expect(res.userSizes).toEqual({ tops: 'M', bottoms: '32 × 30' })
    const row = db.select().from(settings).where(and(eq(settings.key, 'userSizes'), eq(settings.userId, A))).get()
    expect(JSON.parse(row!.value)).toEqual({ tops: 'M', bottoms: '32 × 30' })
  })

  it('merges: a patch leaves other categories alone', () => {
    updateSettings({ userSizes: { tops: 'M' } }, A)
    updateSettings({ userSizes: { shoes: 'US 10' } }, A)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M', shoes: 'US 10' })
  })

  it('an empty (or whitespace, or null) value removes the key', () => {
    updateSettings({ userSizes: { tops: 'M', shoes: 'US 10', bottoms: '32' } }, A)
    updateSettings({ userSizes: { tops: '' } }, A)
    updateSettings({ userSizes: { shoes: '   ' } }, A)
    updateSettings({ userSizes: { bottoms: null } }, A)
    expect(getSettings(A).userSizes).toEqual({})
  })

  it('accepts accessories / underwear (hidden in the UI by default, still valid)', () => {
    updateSettings({ userSizes: { accessories: 'OS', underwear: 'M' } }, A)
    expect(getSettings(A).userSizes).toEqual({ accessories: 'OS', underwear: 'M' })
  })

  it('updateSettings throws on an invalid patch and leaves stored sizes unchanged', () => {
    updateSettings({ userSizes: { tops: 'M' } }, A)
    expect(() => updateSettings({ userSizes: { hats: 'L' } as never }, A)).toThrow(/Invalid userSizes/)
    expect(() => updateSettings({ userSizes: { tops: 'x'.repeat(31) } }, A)).toThrow(/Invalid userSizes/)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M' })
  })

  it('corrupt stored JSON reads as empty instead of throwing', () => {
    setSetting('userSizes', '{not json', A)
    expect(getSettings(A).userSizes).toEqual({})
    setSetting('userSizes', '["tops"]', A)
    expect(getSettings(A).userSizes).toEqual({})
  })

  it('stored entries that are not valid are dropped on read', () => {
    setSetting('userSizes', JSON.stringify({
      tops: 'M', hats: 'L', constructor: 'x', shoes: 42, bottoms: 'y'.repeat(31), outerwear: '  ',
    }), A)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M' })
  })
})

describe('sizesAgentContext', () => {
  it('defaults to on when never set', () => {
    const s = getSettings(A)
    expect(s.sizesAgentContext).toBeUndefined()
    expect(isSizesAgentContextEnabled(s)).toBe(true)
  })

  it('persists off and back on', () => {
    expect(updateSettings({ sizesAgentContext: false }, A).sizesAgentContext).toBe(false)
    expect(isSizesAgentContextEnabled(getSettings(A))).toBe(false)
    expect(updateSettings({ sizesAgentContext: true }, A).sizesAgentContext).toBe(true)
    expect(isSizesAgentContextEnabled(getSettings(A))).toBe(true)
  })

  it('a garbage stored value reads as the default (on)', () => {
    setSetting('sizesAgentContext', 'maybe', A)
    expect(isSizesAgentContextEnabled(getSettings(A))).toBe(true)
  })
})

describe('parseUserSizesPatch', () => {
  it('rejects non-objects, unknown/inherited keys, non-strings and >30 chars', () => {
    expect(parseUserSizesPatch(null)).toBeNull()
    expect(parseUserSizesPatch('M')).toBeNull()
    expect(parseUserSizesPatch(['tops'])).toBeNull()
    expect(parseUserSizesPatch({ hats: 'M' })).toBeNull()
    expect(parseUserSizesPatch({ constructor: 'M' })).toBeNull()
    expect(parseUserSizesPatch(JSON.parse('{"__proto__": "M"}'))).toBeNull()
    expect(parseUserSizesPatch({ tops: 5 })).toBeNull()
    expect(parseUserSizesPatch({ tops: 'x'.repeat(31) })).toBeNull()
  })

  it('accepts exactly 30 chars (after trimming) and trims', () => {
    expect(parseUserSizesPatch({ tops: ` ${'x'.repeat(30)} ` })).toEqual({ tops: 'x'.repeat(30) })
    expect(parseUserSizesPatch({})).toEqual({})
    expect(parseUserSizesPatch({ tops: null })).toEqual({ tops: null })
  })

  it('parseStoredUserSizes tolerates null / empty', () => {
    expect(parseStoredUserSizes(null)).toEqual({})
    expect(parseStoredUserSizes('')).toEqual({})
  })
})

describe('PATCH /api/settings userSizes — end to end against the real settings table', () => {
  function app(userId: string) {
    const a = express()
    a.use(express.json())
    a.use((req, _res, next) => { req.userId = userId; next() })
    a.use('/', settingsRouter)
    return a
  }

  it('saves valid categories and returns them from GET', async () => {
    const res = await request(app(A)).patch('/').send({ userSizes: { tops: 'M', bottoms: '32 × 30', shoes: 'US 10' } })
    expect(res.status).toBe(200)
    expect(res.body.userSizes).toEqual({ tops: 'M', bottoms: '32 × 30', shoes: 'US 10' })
    const get = await request(app(A)).get('/')
    expect(get.body.userSizes).toEqual({ tops: 'M', bottoms: '32 × 30', shoes: 'US 10' })
  })

  it('an empty value removes the key', async () => {
    await request(app(A)).patch('/').send({ userSizes: { tops: 'M', shoes: 'US 10' } })
    const res = await request(app(A)).patch('/').send({ userSizes: { shoes: '' } })
    expect(res.status).toBe(200)
    expect(res.body.userSizes).toEqual({ tops: 'M' })
  })

  it('invalid category → 400, over 30 chars → 400; stored sizes unchanged', async () => {
    await request(app(A)).patch('/').send({ userSizes: { tops: 'M' } })
    expect((await request(app(A)).patch('/').send({ userSizes: { hats: 'L' } })).status).toBe(400)
    expect((await request(app(A)).patch('/').send({ userSizes: { tops: 'x'.repeat(31) } })).status).toBe(400)
    expect(getSettings(A).userSizes).toEqual({ tops: 'M' })
  })

  it('GET for user B never includes user A\'s sizes', async () => {
    await request(app(A)).patch('/').send({ userSizes: { tops: 'M' } })
    const get = await request(app(B)).get('/')
    expect(get.body.userSizes).toBeUndefined()
  })

  it('the agent-context toggle persists', async () => {
    const res = await request(app(A)).patch('/').send({ sizesAgentContext: false })
    expect(res.body.sizesAgentContext).toBe(false)
    expect((await request(app(A)).get('/')).body.sizesAgentContext).toBe(false)
  })
})
