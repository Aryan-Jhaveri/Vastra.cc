import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../../../src/tools/tags.js', () => ({
  listFacetUsage: vi.fn(),
}))

vi.mock('../../../../src/db/queries.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

import * as tagsTools from '../../../../src/tools/tags.js'
import * as queriesMod from '../../../../src/db/queries.js'
import suggestOccasionsRouter from '../../../../src/transport/web/routes/suggest-occasions.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => { req.userId = 'test-user'; next() })
  app.use('/', suggestOccasionsRouter)
  return app
}

// #372: the pill row shows the user's created occasions (items + outfits,
// most used first) — the same list as "Your occasions" in the editors. The
// counting is covered in test/tools/tags.test.ts.
function usage(...values: string[]) {
  return values.map(value => ({ value, items: 1, outfits: 0, collections: 0 }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(queriesMod.getSetting).mockReturnValue(null)
  vi.mocked(queriesMod.setSetting).mockReturnValue(undefined as any)
  vi.mocked(tagsTools.listFacetUsage).mockReturnValue([])
})

describe('GET /', () => {
  it('returns presets unconditionally', async () => {
    const res = await request(makeApp()).get('/')
    expect(res.status).toBe(200)
    expect(res.body.presets).toEqual(['casual', 'work', 'formal', 'outdoor', 'date'])
    expect(res.body.derived).toEqual([])
    expect(res.body.hidden).toEqual([])
  })

  it('lists created occasions for this user, in usage order, minus presets, up to 8', async () => {
    vi.mocked(tagsTools.listFacetUsage).mockReturnValue(usage('club', 'work', 'brunch', 'casual', 'gala', 'hike', 'dance', 'beach', 'gym', 'opera', 'picnic'))
    const res = await request(makeApp()).get('/')
    expect(tagsTools.listFacetUsage).toHaveBeenCalledWith('test-user', 'occasion')
    expect(res.body.derived).toEqual(['club', 'brunch', 'gala', 'hike', 'dance', 'beach', 'gym', 'opera'])
  })

  it('excludes hidden values', async () => {
    vi.mocked(queriesMod.getSetting).mockReturnValue(JSON.stringify(['club']))
    vi.mocked(tagsTools.listFacetUsage).mockReturnValue(usage('club', 'brunch'))
    const res = await request(makeApp()).get('/')
    expect(res.body.derived).toEqual(['brunch'])
    expect(res.body.hidden).toEqual(['club'])
  })
})

describe('POST /hide', () => {
  it('appends value to hidden settings', async () => {
    vi.mocked(queriesMod.getSetting).mockReturnValue(null)

    const app = makeApp()
    const res = await request(app)
      .post('/hide')
      .send({ value: 'club' })

    expect(res.status).toBe(204)
    expect(queriesMod.setSetting).toHaveBeenCalledWith(
      'hiddenSuggestOccasions',
      JSON.stringify(['club']),
      'test-user',
    )
  })

  it('is idempotent — does not create duplicates', async () => {
    vi.mocked(queriesMod.getSetting).mockReturnValue(JSON.stringify(['club']))

    const app = makeApp()
    const res = await request(app)
      .post('/hide')
      .send({ value: 'club' })

    expect(res.status).toBe(204)
    expect(queriesMod.setSetting).not.toHaveBeenCalled()
  })

  it('validates value is required and max 40 chars', async () => {
    const app = makeApp()
    const resEmpty = await request(app)
      .post('/hide')
      .send({ value: '' })

    expect(resEmpty.status).toBe(400)

    const resLong = await request(app)
      .post('/hide')
      .send({ value: 'a'.repeat(41) })

    expect(resLong.status).toBe(400)
  })

  it('normalises to lowercase', async () => {
    vi.mocked(queriesMod.getSetting).mockReturnValue(null)

    const app = makeApp()
    await request(app).post('/hide').send({ value: 'CLUB' })

    expect(queriesMod.setSetting).toHaveBeenCalledWith(
      'hiddenSuggestOccasions',
      JSON.stringify(['club']),
      'test-user',
    )
  })
})