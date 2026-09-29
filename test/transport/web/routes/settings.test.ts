import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../../../src/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/settings.js')>()
  return {
    ...actual,
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  }
})

import * as settingsModule from '../../../../src/settings.js'
import settingsRouter from '../../../../src/transport/web/routes/settings.js'

function makeApp(userId = 'user-test') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  app.use('/', settingsRouter)
  return app
}

describe('GET /api/settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns current settings', async () => {
    vi.mocked(settingsModule.getSettings).mockReturnValue({ themeId: 'silk' })

    const res = await request(makeApp()).get('/')
    expect(res.status).toBe(200)
    expect(res.body.themeId).toBe('silk')
  })

  it('returns empty object when no settings', async () => {
    vi.mocked(settingsModule.getSettings).mockReturnValue({})

    const res = await request(makeApp()).get('/')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
  })
})

describe('PATCH /api/settings', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ignores unknown fields', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({})

    const res = await request(makeApp())
      .patch('/')
      .send({ unknownField: 'value' })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({}, 'user-test')
  })

  it('updates themeId and colorScheme', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({
      themeId: 'terra',
      colorScheme: 'dark',
    })

    const res = await request(makeApp())
      .patch('/')
      .send({ themeId: 'terra', colorScheme: 'dark', themeIdHack: 'nope' })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith(
      { themeId: 'terra', colorScheme: 'dark' },
      'user-test',
    )
  })

  it('rejects invalid themeId', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({})

    const res = await request(makeApp())
      .patch('/')
      .send({ themeId: 'not-a-theme', colorScheme: 'dark' })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ colorScheme: 'dark' }, 'user-test')
  })

  it('rejects invalid colorScheme', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ themeId: 'silk' })

    const res = await request(makeApp())
      .patch('/')
      .send({ themeId: 'silk', colorScheme: 'sepia' })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ themeId: 'silk' }, 'user-test')
  })

  it('saves a valid serverLocation for the authenticated user', async () => {
    const location = { enabled: true, lat: 51.5, lon: -0.12, name: 'London' }
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ serverLocation: location })

    const res = await request(makeApp())
      .patch('/')
      .send({ serverLocation: location })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ serverLocation: location }, 'user-test')
  })

  // A silent 200 would make the client believe a location was stored.
  it('rejects an invalid serverLocation with 400 instead of ignoring it', async () => {
    const res = await request(makeApp())
      .patch('/')
      .send({ serverLocation: { enabled: true, lat: 999, lon: 0, name: 'Nowhere' } })

    expect(res.status).toBe(400)
    expect(settingsModule.updateSettings).not.toHaveBeenCalled()
  })

  it('accepts disabling the saved location', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ serverLocation: { enabled: false } })

    const res = await request(makeApp())
      .patch('/')
      .send({ serverLocation: { enabled: false } })

    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ serverLocation: { enabled: false } }, 'user-test')
  })
})

describe('PATCH /api/settings — shopGender', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a valid value', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ shopGender: 'male' })
    const res = await request(makeApp()).patch('/').send({ shopGender: 'male' })
    expect(res.status).toBe(200)
    expect(vi.mocked(settingsModule.updateSettings).mock.calls[0][0]).toEqual({ shopGender: 'male' })
  })

  it('rejects an invalid value instead of pretending it saved', async () => {
    const res = await request(makeApp()).patch('/').send({ shopGender: 'Women' })
    expect(res.status).toBe(400)
    expect(settingsModule.updateSettings).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/settings — userSizes / sizesAgentContext (#329)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes a valid, trimmed sizes patch to updateSettings for the authenticated user', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ userSizes: { tops: 'M' } })
    const res = await request(makeApp()).patch('/').send({ userSizes: { tops: ' M ', shoes: '' } })
    expect(res.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ userSizes: { tops: 'M', shoes: '' } }, 'user-test')
  })

  it.each([
    ['unknown category', { hats: 'M' }],
    ['inherited key', { constructor: 'M' }],
    ['value over 30 chars', { tops: 'x'.repeat(31) }],
    ['non-string value', { tops: 42 }],
    ['not an object', 'M'],
    ['an array', ['tops']],
  ])('rejects %s with 400 and writes nothing', async (_label, userSizes) => {
    const res = await request(makeApp()).patch('/').send({ userSizes })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/userSizes/)
    expect(settingsModule.updateSettings).not.toHaveBeenCalled()
  })

  it('rejects the whole request when one entry is bad (no partial save)', async () => {
    const res = await request(makeApp()).patch('/').send({ userSizes: { tops: 'M', hats: 'L' }, themeId: 'silk' })
    expect(res.status).toBe(400)
    expect(settingsModule.updateSettings).not.toHaveBeenCalled()
  })

  it('accepts a boolean sizesAgentContext and rejects anything else', async () => {
    vi.mocked(settingsModule.updateSettings).mockReturnValue({ sizesAgentContext: false })
    const ok = await request(makeApp()).patch('/').send({ sizesAgentContext: false })
    expect(ok.status).toBe(200)
    expect(settingsModule.updateSettings).toHaveBeenCalledWith({ sizesAgentContext: false }, 'user-test')

    vi.mocked(settingsModule.updateSettings).mockClear()
    const bad = await request(makeApp()).patch('/').send({ sizesAgentContext: 'no' })
    expect(bad.status).toBe(400)
    expect(settingsModule.updateSettings).not.toHaveBeenCalled()
  })
})
