import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import request from 'supertest'
import express from 'express'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'

// #329 privacy: the user's sizes are personal data. They must never reach
// share payloads, Discover prompts/embeddings, analytics events, Jev, or any
// outbound store call. The only reader is the agent's get_my_sizes tool.
//
// Two layers: a source scan (regression guard — none of these code paths may
// even mention the sizes settings), and runtime spies on the settings getter
// for the share + analytics routes. Discover and the shop outbound body are
// covered in discover.test.ts and shop.test.ts.

// The getter is a spy that WOULD return sizes — any path that reads it fails.
vi.mock('../../src/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/settings.js')>()
  return {
    ...actual,
    getSettings: vi.fn(() => ({ userSizes: { tops: 'ZZSIZE-TOPS' }, sizesAgentContext: true })),
  }
})

vi.mock('../../src/ai/embedImage.js', () => ({
  embedShareImageOnSave: vi.fn(),
  deleteEmbeddingsForShare: vi.fn(),
}))
vi.mock('../../src/ai/embed.js', () => ({
  embedShareTextOnSave: vi.fn(),
  deleteTextEmbeddingsForShare: vi.fn(),
}))
vi.mock('../../src/ai/instrumented.js', () => ({
  runEmbeddingInstrumented: vi.fn(),
}))

import * as settingsMod from '../../src/settings.js'
import { db } from '../../src/db/client.js'
import { users, sharePayloads, analyticsEvents } from '../../src/db/schema.js'
import shareRouter from '../../src/transport/web/routes/share.js'
import analyticsRouter from '../../src/transport/web/routes/analytics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')
const U = 'sizes-privacy-user'

beforeAll(() => {
  migrate(db, { migrationsFolder: join(ROOT, 'src/db/migrations') })
  if (!db.select().from(users).where(eq(users.id, U)).get()) {
    db.insert(users).values({ id: U, email: `${U}@local.closet`, createdAt: Date.now() }).run()
  }
})

beforeEach(() => vi.clearAllMocks())

function app(router: express.Router) {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.userId = U; next() })
  a.use('/', router)
  return a
}

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('sizes never enter share / Discover / analytics / store / Jev code paths', () => {
  const GUARDED = [
    'src/tools/share.ts',
    'src/transport/web/routes/share.ts',
    'src/transport/web/routes/shareTarget.ts',
    'src/transport/web/routes/discover.ts',
    'src/transport/web/routes/analytics.ts',
    'src/transport/web/routes/shop.ts',
    'src/ai/discover.ts',
    'src/ai/discoverEvents.ts',
    'src/ai/inspiration.ts',
    'src/ai/embed.ts',
    'src/ai/embedImage.ts',
    'src/ai/decisions.ts',
    'src/ai/decisionText.ts',
    'src/ai/shopRank.ts',
    ...listTs(join(ROOT, 'src/commerce')).map(p => relative(ROOT, p)),
  ]

  it.each(GUARDED.filter(f => { try { statSync(join(ROOT, f)); return true } catch { return false } }))(
    '%s does not reference userSizes / sizesAgentContext',
    (file) => {
      const src = readFileSync(join(ROOT, file), 'utf-8')
      expect(src).not.toMatch(/userSizes|sizesAgentContext|UserSizes|get_my_sizes/)
    },
  )
})

describe('share + analytics routes never read the settings getter (#329)', () => {
  it('POST /api/share stores a payload without sizes and never calls getSettings', async () => {
    const res = await request(app(shareRouter)).post('/').send({ source: 'manual', description: 'my look' })
    expect(res.status).toBe(201)
    expect(settingsMod.getSettings).not.toHaveBeenCalled()
    const row = db.select().from(sharePayloads).where(eq(sharePayloads.id, res.body.id)).get()
    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain('ZZSIZE')
  })

  it('POST /api/analytics never calls getSettings and stores no sizes', async () => {
    const id = `evt_${Date.now()}`
    const res = await request(app(analyticsRouter)).post('/').send({
      events: [{ id, sessionId: 's1', eventType: 'page_view', route: '/settings/sizes', createdAt: Date.now() }],
    })
    expect(res.status).toBeLessThan(300)
    expect(settingsMod.getSettings).not.toHaveBeenCalled()
    const row = db.select().from(analyticsEvents).where(eq(analyticsEvents.id, id)).get()
    expect(JSON.stringify(row ?? {})).not.toContain('ZZSIZE')
  })
})
