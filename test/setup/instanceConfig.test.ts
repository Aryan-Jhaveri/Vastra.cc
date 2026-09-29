import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { describeInstanceConfig } from '../../src/setup/instanceConfig.js'
import { quietHostedKeyHooks } from '../helpers/quietHostedHooks.js'

// #315 — Settings › Instance. Secrets never leave the server; URLs lose any
// embedded credentials; only admins can read it.

vi.mock('../../src/db/reconcileMigrations.js', () => ({ reconcileMigrations: vi.fn() }))
vi.mock('../../src/jobs/seed.js', () => ({ seedDefaultJobs: vi.fn() }))
vi.mock('../../src/jobs/types/index.js', () => ({ registerBuiltInJobTypes: vi.fn() }))
vi.mock('../../src/jobs/scheduler.js', () => ({ initScheduler: vi.fn() }))
quietHostedKeyHooks()

afterEach(() => { vi.unstubAllEnvs() })

describe('describeInstanceConfig', () => {
  it('reports secrets as set/unset only and strips user:password from URLs', () => {
    const config = describeInstanceConfig({
      GEMINI_API_KEY: 'AIza-SECRET-1', OPENAI_COMPAT_API_KEY: 'sk-SECRET-2', VAPID_PRIVATE_KEY: 'SECRET-3',
      OPENAI_COMPAT_BASE_URL: 'http://bob:SECRET-4@gpu.lan:8001/v1', TEXT_MODEL: 'local/qwen3-vl:8b',
    } as NodeJS.ProcessEnv)
    const text = JSON.stringify(config)
    expect(text).not.toMatch(/SECRET/)
    const entries = Object.fromEntries(config.groups.flatMap(g => g.entries).map(e => [e.key, e]))
    expect(entries.GEMINI_API_KEY).toEqual({ key: 'GEMINI_API_KEY', set: true, value: null, secret: true })
    expect(entries.RESEND_API_KEY).toEqual({ key: 'RESEND_API_KEY', set: false, value: null, secret: true })
    expect(entries.OPENAI_COMPAT_BASE_URL.value).toBe('http://gpu.lan:8001/v1')
    expect(entries.TEXT_MODEL.value).toBe('local/qwen3-vl:8b')
    expect(entries.GCP_PROJECT_ID).toMatchObject({ set: false, value: null })
  })
})

describe('GET /api/admin/config and /api/auth/me isAdmin', () => {
  async function importApp(): Promise<Express> {
    vi.resetModules()
    return (await import('../../src/transport/web/server.js')).app
  }
  async function sessionFor(id: string, isAdmin: boolean): Promise<string> {
    const { db } = await import('../../src/db/client.js')
    const { users } = await import('../../src/db/schema.js')
    const { createSession } = await import('../../src/db/queries.js')
    db.insert(users).values({ id, email: `${id}@local.closet`, isAdmin, createdAt: Date.now() }).onConflictDoNothing().run()
    return `closet-auth=${createSession(id).token}`
  }

  it('admin: 200 with no secret values; non-admin: 403; the me flag follows is_admin', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'AIza-SECRET-route')
    const app = await importApp()
    const admin = await sessionFor('user_cfg_admin', true)
    const plain = await sessionFor('user_cfg_plain', false)

    const ok = await request(app).get('/api/admin/config').set('Cookie', admin)
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.body)).not.toContain('AIza-SECRET-route')
    expect(ok.body.groups.length).toBeGreaterThan(0)

    expect((await request(app).get('/api/admin/config').set('Cookie', plain)).status).toBe(403)
    expect((await request(app).get('/api/admin/config')).status).toBe(401)

    expect((await request(app).get('/api/auth/me').set('Cookie', plain)).body.isAdmin).toBe(false)
    expect((await request(app).get('/api/auth/me').set('Cookie', admin)).body.isAdmin).toBe(true)
  })
})
