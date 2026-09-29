import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { quietHostedKeyHooks } from '../../helpers/quietHostedHooks.js'

// OSS audit 2026-09-28 — an admin mapped onto the legacy shared 'self' closet
// can't delete that closet from Settings or mint tokens owned by it.

vi.mock('../../../src/db/reconcileMigrations.js', () => ({ reconcileMigrations: vi.fn() }))
vi.mock('../../../src/jobs/seed.js', () => ({ seedDefaultJobs: vi.fn() }))
vi.mock('../../../src/jobs/types/index.js', () => ({ registerBuiltInJobTypes: vi.fn() }))
vi.mock('../../../src/jobs/scheduler.js', () => ({ initScheduler: vi.fn() }))
quietHostedKeyHooks()

const hosted = process.env.HOSTED_MODE
beforeEach(() => { delete process.env.HOSTED_MODE })
afterEach(() => {
  if (hosted === undefined) delete process.env.HOSTED_MODE
  else process.env.HOSTED_MODE = hosted
})

async function setup(): Promise<{ app: Express; admin: string; plain: string }> {
  vi.resetModules()
  const app = (await import('../../../src/transport/web/server.js')).app
  const { db } = await import('../../../src/db/client.js')
  const { users } = await import('../../../src/db/schema.js')
  const { createSession } = await import('../../../src/db/queries.js')
  for (const [id, isAdmin] of [['user_shared_admin', true], ['user_shared_plain', false]] as const) {
    db.insert(users).values({ id, email: `${id}@local.closet`, isAdmin, createdAt: Date.now() }).onConflictDoNothing().run()
  }
  return {
    app,
    admin: `closet-auth=${createSession('user_shared_admin').token}`,
    plain: `closet-auth=${createSession('user_shared_plain').token}`,
  }
}

const H = { 'X-Requested-With': 'vastra' }

describe('admin acting as the shared closet', () => {
  it('DELETE /api/account is refused and the shared "self" user survives', async () => {
    const { app, admin } = await setup()
    const res = await request(app).delete('/api/account').set('Cookie', admin).set(H)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('shared_closet')
    const { getUserById } = await import('../../../src/db/queries.js')
    expect(getUserById('self')).toBeDefined()
    expect(getUserById('user_shared_admin')).toBeDefined()
  })

  it('POST /api/tokens is refused (no token owned by "self")', async () => {
    const { app, admin } = await setup()
    const res = await request(app).post('/api/tokens').set('Cookie', admin).set(H).send({ name: 'agent', scopes: ['read'] })
    expect(res.status).toBe(409)
  })

  it('a normal user can still delete their own account', async () => {
    const { app, plain } = await setup()
    await request(app).delete('/api/account').set('Cookie', plain).set(H).expect(200)
    const { getUserById } = await import('../../../src/db/queries.js')
    expect(getUserById('user_shared_plain')).toBeUndefined()
  })
})
