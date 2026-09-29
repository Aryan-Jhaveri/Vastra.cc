import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quietHostedKeyHooks } from '../../helpers/quietHostedHooks.js'
import request from 'supertest'
import type { Express } from 'express'

// #328 — the /api/chat mount through the real server.ts middleware chain:
// requireChatEnabled → requireSession → requireCsrfForMutations → router.
// Boot side effects are mocked as in hostedModeRoutes.test.ts; the chat
// router, sessions and DB are real.

vi.mock('../../../src/db/reconcileMigrations.js', () => ({ reconcileMigrations: vi.fn() }))
vi.mock('../../../src/jobs/seed.js', () => ({ seedDefaultJobs: vi.fn() }))
vi.mock('../../../src/jobs/types/index.js', () => ({ registerBuiltInJobTypes: vi.fn() }))
vi.mock('../../../src/jobs/scheduler.js', () => ({ initScheduler: vi.fn() }))
quietHostedKeyHooks()

const ENV_KEYS = ['HOSTED_MODE', 'CHAT_ENABLED', 'GEMINI_API_KEY', 'GCP_PROJECT_ID', 'AGENT_MODEL', 'OPENROUTER_API_KEY']
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  // Deterministic regardless of the developer's .env (server.ts loads it).
  delete process.env.AGENT_MODEL
})

async function importApp(): Promise<Express> {
  vi.resetModules()
  return (await import('../../../src/transport/web/server.js')).app
}

async function session(userId = 'self'): Promise<string> {
  const { createSession } = await import('../../../src/db/queries.js')
  return `closet-auth=${createSession(userId).token}`
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('chat gating', () => {
  beforeEach(() => { vi.resetModules() })

  it('self-host with a text model: mounted (401 without a session) and chatEnabled=true', async () => {
    delete process.env.HOSTED_MODE
    const app = await importApp()
    expect((await request(app).get('/api/chat/threads')).status).toBe(401)
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(true)
  })

  it('self-host without any text model: 404 and chatEnabled=false', async () => {
    delete process.env.HOSTED_MODE
    delete process.env.GEMINI_API_KEY
    delete process.env.GCP_PROJECT_ID
    const app = await importApp()
    expect((await request(app).get('/api/chat/threads').set('Cookie', await session())).status).toBe(404)
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(false)
  })

  it('hosted: 404 even with a session until CHAT_ENABLED=true', async () => {
    process.env.HOSTED_MODE = 'true'
    delete process.env.CHAT_ENABLED
    const app = await importApp()
    const cookie = await session()
    const off = await request(app).get('/api/chat/threads').set('Cookie', cookie)
    expect(off.status).toBe(404)
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(false)

    process.env.CHAT_ENABLED = 'true'
    expect((await request(app).get('/api/chat/threads').set('Cookie', cookie)).status).toBe(200)
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(true)
  })

  it('an OpenRouter AGENT_MODEL needs the OpenRouter key', async () => {
    delete process.env.HOSTED_MODE
    process.env.AGENT_MODEL = 'mistralai/mistral-small'
    delete process.env.OPENROUTER_API_KEY
    const app = await importApp()
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(false)
    process.env.OPENROUTER_API_KEY = 'k'
    expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(true)
  })
})

describe('CSRF runs before the router', () => {
  it('a cookie-only POST without the CSRF header is 403 and never takes the turn lease', async () => {
    delete process.env.HOSTED_MODE
    const app = await importApp()
    const { db } = await import('../../../src/db/client.js')
    const { chatTurnLeases, chatThreads } = await import('../../../src/db/schema.js')
    db.delete(chatTurnLeases).run()
    db.delete(chatThreads).run()

    const res = await request(app).post('/api/chat/stream').set('Cookie', await session()).send({ message: 'hi' })

    expect(res.status).toBe(403)
    expect(db.select().from(chatTurnLeases).all()).toHaveLength(0)
    expect(db.select().from(chatThreads).all()).toHaveLength(0)
  })
})

describe('#248 — threat model rows through the real middleware (#328)', () => {
  it('hosted with CHAT_ENABLED=true but no daily spend cap stays off (#1: fail closed)', async () => {
    process.env.HOSTED_MODE = 'true'
    process.env.CHAT_ENABLED = 'true'
    const cap = process.env.CHAT_DAILY_SPEND_CAP_CENTS
    delete process.env.CHAT_DAILY_SPEND_CAP_CENTS
    try {
      const app = await importApp()
      expect((await request(app).get('/api/chat/threads').set('Cookie', await session())).status).toBe(404)
      expect((await request(app).get('/api/auth/status')).body.chatEnabled).toBe(false)
    } finally {
      process.env.CHAT_DAILY_SPEND_CAP_CENTS = cap
    }
  })

  it('an admin session acts as the effective user "self", never its own id (#11)', async () => {
    delete process.env.HOSTED_MODE
    const app = await importApp()
    const { db } = await import('../../../src/db/client.js')
    const { chatThreads, users } = await import('../../../src/db/schema.js')
    const { createThread } = await import('../../../src/agent/chatStore.js')
    db.delete(chatThreads).run()
    for (const [id, isAdmin] of [['user_chat_admin', true], ['user_chat_plain', false]] as const) {
      db.insert(users).values({ id, email: `${id}@local.closet`, isAdmin, createdAt: Date.now() }).onConflictDoNothing().run()
    }
    const selfThread = createThread('self', 'shared closet question')

    const asAdmin = await request(app).get('/api/chat/threads').set('Cookie', await session('user_chat_admin'))
    expect(asAdmin.body.threads.map((t: { id: string }) => t.id)).toEqual([selfThread.id])

    const asPlain = await request(app).get('/api/chat/threads').set('Cookie', await session('user_chat_plain'))
    expect(asPlain.body.threads).toEqual([])
    expect((await request(app).get(`/api/chat/threads/${selfThread.id}`).set('Cookie', await session('user_chat_plain'))).status).toBe(404)
  })

  it('request logs never contain message content (#9)', async () => {
    delete process.env.HOSTED_MODE
    const app = await importApp()
    const lines: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true })
    try {
      const marker = 'my-waist-is-32-PRIVATE-MARKER'
      const cookie = await session()
      // Rejected by CSRF, and rejected as too long: both are logged, neither may carry the body.
      await request(app).post('/api/chat/stream').set('Cookie', cookie).send({ message: marker })
      await request(app).post('/api/chat/stream').set('Cookie', cookie).set('X-Requested-With', 'vastra')
        .set('Origin', 'http://127.0.0.1').send({ message: `${marker} ${'x'.repeat(2_100)}` })
    } finally {
      write.mockRestore()
    }
    expect(lines.some(l => l.includes('/api/chat/stream'))).toBe(true)
    expect(lines.join('')).not.toContain('PRIVATE-MARKER')
  })
})
