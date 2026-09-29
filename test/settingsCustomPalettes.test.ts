import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { users, settings } from '../src/db/schema.js'
import { setSetting } from '../src/db/queries.js'
import { getSettings, updateSettings, isValidCustomThemePalettes, type CustomThemePalette } from '../src/settings.js'
import settingsRouter from '../src/transport/web/routes/settings.js'

// Custom theme palettes: four slots, each with light + dark primary/secondary/
// tertiary hex colours, stored per user in the settings table.

const __dirname = dirname(fileURLToPath(import.meta.url))
const A = 'palette-user-a'
const B = 'palette-user-b'

const palette: CustomThemePalette = {
  light: { primary: '#112233', secondary: '#f5f5f5', tertiary: '#000000' },
  dark: { primary: '#aabbcc', secondary: '#0a0a0a', tertiary: '#ffffff' },
}

function appAs(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.use('/', settingsRouter)
  return app
}

beforeAll(() => {
  migrate(db, { migrationsFolder: join(__dirname, '../src/db/migrations') })
  for (const id of [A, B]) {
    if (!db.select().from(users).where(eq(users.id, id)).get()) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

beforeEach(() => {
  for (const key of ['customPalettes', 'customPaletteSlot']) {
    db.delete(settings).where(eq(settings.key, key)).run()
  }
})

describe('isValidCustomThemePalettes', () => {
  it('accepts slots 1-4 with six hex colours', () => {
    expect(isValidCustomThemePalettes({})).toBe(true)
    expect(isValidCustomThemePalettes({ 1: palette, 4: palette })).toBe(true)
  })

  it.each([
    ['slot 5', { 5: palette }],
    ['short hex', { 1: { ...palette, light: { ...palette.light, primary: '#123' } } }],
    ['css injection', { 1: { ...palette, dark: { ...palette.dark, tertiary: 'red;}body{display:none' } } }],
    ['extra colour key', { 1: { ...palette, light: { ...palette.light, quaternary: '#000000' } } }],
    ['missing dark mode', { 1: { light: palette.light } }],
    ['array', [palette]],
  ])('rejects %s', (_label, value) => {
    expect(isValidCustomThemePalettes(value)).toBe(false)
  })
})

describe('getSettings / updateSettings', () => {
  it('round-trips palettes and the selected slot, per user', () => {
    updateSettings({ customPalettes: { 2: palette }, customPaletteSlot: 2 }, A)
    expect(getSettings(A)).toMatchObject({ customPalettes: { 2: palette }, customPaletteSlot: 2 })
    expect(getSettings(B).customPalettes).toBeUndefined()
    expect(getSettings(B).customPaletteSlot).toBeUndefined()
  })

  it('refuses to select an empty slot', () => {
    updateSettings({ customPalettes: { 1: palette } }, A)
    expect(() => updateSettings({ customPaletteSlot: 3 }, A)).toThrow(/empty/)
  })

  it('clears the selection with null', () => {
    updateSettings({ customPalettes: { 1: palette }, customPaletteSlot: 1 }, A)
    updateSettings({ customPaletteSlot: null }, A)
    expect(getSettings(A).customPaletteSlot).toBeUndefined()
  })

  it('drops a selection whose palette was deleted', () => {
    updateSettings({ customPalettes: { 1: palette }, customPaletteSlot: 1 }, A)
    updateSettings({ customPalettes: {} }, A)
    expect(getSettings(A).customPaletteSlot).toBeUndefined()
  })

  it('reads corrupt stored JSON as no palettes instead of throwing', () => {
    setSetting('customPalettes', '{not json', A)
    setSetting('customPaletteSlot', '1', A)
    expect(getSettings(A).customPalettes).toBeUndefined()
    expect(getSettings(A).customPaletteSlot).toBeUndefined()
  })
})

describe('PATCH /api/settings — custom palettes', () => {
  it('saves a valid palette for the authenticated user only', async () => {
    const res = await request(appAs(A)).patch('/').send({ customPalettes: { 1: palette }, customPaletteSlot: 1 })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ customPalettes: { 1: palette }, customPaletteSlot: 1 })
    expect(getSettings(B).customPalettes).toBeUndefined()
  })

  it('400 for an invalid palette, writing nothing', async () => {
    const res = await request(appAs(A)).patch('/').send({ customPalettes: { 1: { light: palette.light, dark: { ...palette.dark, primary: 'url(x)' } } } })
    expect(res.status).toBe(400)
    expect(getSettings(A).customPalettes).toBeUndefined()
  })

  it('400 (not 500) when selecting an empty slot', async () => {
    const res = await request(appAs(A)).patch('/').send({ customPaletteSlot: 2 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Custom palette slot is empty')
  })

  it('does not let user B select a slot that only user A has filled', async () => {
    updateSettings({ customPalettes: { 1: palette } }, A)
    const res = await request(appAs(B)).patch('/').send({ customPaletteSlot: 1 })
    expect(res.status).toBe(400)
  })

  it('400 for an out-of-range slot', async () => {
    const res = await request(appAs(A)).patch('/').send({ customPaletteSlot: 5 })
    expect(res.status).toBe(400)
  })
})
