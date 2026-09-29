import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const originalEnv = { ...process.env }

// server.ts imports 'dotenv/config' at module top, which re-injects vars from
// .env on every re-import. Without this mock, vi.resetModules + dynamic import
// re-runs dotenv and resurrects GCP_PROJECT_ID after the test deletes it,
// causing the "throws in production" case to silently pass through the guard.
vi.mock('dotenv/config', () => ({}))

vi.mock('../../../src/db/client.js', () => ({
  db: {},
  DATA_DIR: '/tmp/closet-test',
  getSqlite: vi.fn(() => ({})),
}))

vi.mock('../../../src/db/reconcileMigrations.js', () => ({
  reconcileMigrations: vi.fn(),
}))

vi.mock('../../../src/jobs/seed.js', () => ({
  seedDefaultJobs: vi.fn(),
}))

vi.mock('../../../src/jobs/types/index.js', () => ({
  registerBuiltInJobTypes: vi.fn(),
}))

vi.mock('../../../src/jobs/scheduler.js', () => ({
  initScheduler: vi.fn(),
}))

function mockRouter() {
  const { Router } = require('express')
  const r = Router()
  r.get('/', (_req: any, res: any) => res.json([]))
  return { default: r }
}

vi.mock('../../../src/transport/web/routes/items.js', mockRouter)
vi.mock('../../../src/transport/web/routes/outfits.js', mockRouter)
vi.mock('../../../src/transport/web/routes/weather.js', mockRouter)
vi.mock('../../../src/transport/web/routes/userPhotos.js', mockRouter)
vi.mock('../../../src/transport/web/routes/tryon.js', mockRouter)
vi.mock('../../../src/transport/web/routes/jobs.js', mockRouter)
vi.mock('../../../src/transport/web/routes/settings.js', mockRouter)
vi.mock('../../../src/transport/web/routes/collections.js', mockRouter)
vi.mock('../../../src/transport/web/routes/discover.js', mockRouter)
vi.mock('../../../src/transport/web/routes/share.js', mockRouter)
vi.mock('../../../src/transport/web/routes/push.js', mockRouter)
vi.mock('../../../src/transport/web/routes/suggest-occasions.js', mockRouter)
vi.mock('../../../src/transport/web/routes/analytics.js', mockRouter)

describe('assertGcpProjectId', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.GCP_PROJECT_ID
    delete process.env.NODE_ENV
    // #315 — the guard keys on HOSTED_MODE, not NODE_ENV. Each test sets it
    // explicitly so the assertions don't depend on the global vitest default.
    delete process.env.HOSTED_MODE
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('throws in HOSTED_MODE without GCP_PROJECT_ID', async () => {
    process.env.HOSTED_MODE = 'true'
    delete process.env.GCP_PROJECT_ID

    const { assertGcpProjectId } = await import('../../../src/transport/web/server.js')
    expect(() => assertGcpProjectId()).toThrow(
      'Refusing to start: GCP_PROJECT_ID required in HOSTED_MODE to prevent Developer-API personal-billing fallback.',
    )
  })

  it('does not throw in HOSTED_MODE with GCP_PROJECT_ID set', async () => {
    process.env.HOSTED_MODE = 'true'
    process.env.GCP_PROJECT_ID = 'test-project'

    const { assertGcpProjectId } = await import('../../../src/transport/web/server.js')
    expect(() => assertGcpProjectId()).not.toThrow()
  })

  it('does not throw when self-hosted (HOSTED_MODE off) even in production without GCP_PROJECT_ID', async () => {
    // #315 — a self-hosted production boot with no keys must start cleanly.
    process.env.NODE_ENV = 'production'
    delete process.env.HOSTED_MODE
    delete process.env.GCP_PROJECT_ID

    const { assertGcpProjectId } = await import('../../../src/transport/web/server.js')
    expect(() => assertGcpProjectId()).not.toThrow()
  })

  it('does not throw in dev without GCP_PROJECT_ID', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.HOSTED_MODE
    delete process.env.GCP_PROJECT_ID

    const { assertGcpProjectId } = await import('../../../src/transport/web/server.js')
    expect(() => assertGcpProjectId()).not.toThrow()
  })
})
