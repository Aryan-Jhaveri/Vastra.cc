import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { MessageRequest, ModelEvent, ModelToolCall } from '../../../../src/ai/messages.js'

// Router-level: the session is stubbed (req.userId), CSRF/gating order is
// covered by test/transport/web/chatMount.test.ts. Only the model stream is
// scripted; the loop, DB, wallet and tools run for real.

interface Scripted { text?: string; toolCalls?: ModelToolCall[] }
const { script, requests } = vi.hoisted(() => ({
  script: [] as Scripted[],
  requests: [] as MessageRequest[],
}))

vi.mock('../../../../src/ai/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/ai/client.js')>()
  const { validate } = await import('../../../../src/ai/messageAdapters.js')
  return {
    ...actual,
    streamMessages: (request: MessageRequest, model: string) => (async function* () {
      validate(request, !model.includes('/'), model)
      requests.push(request)
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      if (next.text) yield { type: 'text_delta', text: next.text } as ModelEvent
      yield {
        type: 'complete',
        response: {
          message: { role: 'assistant', content: next.text ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) },
          usage: { tokensIn: 10, tokensOut: 5 },
          finishReason: next.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      } as ModelEvent
    })(),
  }
})

import { db } from '../../../../src/db/client.js'
import { agentPendingActions, aiCalls, chatThreads, chatTurnLeases, items, outfits, users } from '../../../../src/db/schema.js'
import chatRouter from '../../../../src/transport/web/routes/chat.js'
import { acquireTurnLease, createThread, releaseTurnLease } from '../../../../src/agent/chatStore.js'

const U = 'self'
const OTHER = 'user_chat_route_other'

beforeAll(() => {
  if (!db.select().from(users).where(eq(users.id, OTHER)).get()) {
    db.insert(users).values({ id: OTHER, email: `${OTHER}@local.closet`, createdAt: Date.now() }).run()
  }
})

beforeEach(() => {
  script.length = 0
  requests.length = 0
  db.delete(chatTurnLeases).run()
  db.delete(chatThreads).run()
  db.delete(aiCalls).run()
  db.delete(outfits).run()
  db.delete(items).run()
  process.env.HOSTED_MODE = 'true'
})

function makeApp(userId = U) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = userId; req.authVia = 'cookie'; next() })
  app.use('/api/chat', chatRouter)
  return app
}

function parseSse(text: string): Array<Record<string, unknown>> {
  return text.split('\n\n').filter(f => f.startsWith('event:')).map(frame => {
    const data = frame.split('\n').find(l => l.startsWith('data:'))!.slice(5).trim()
    return JSON.parse(data) as Record<string, unknown>
  })
}

function seedItem(userId: string, id: string) {
  const now = Date.now()
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: now, updatedAt: now }).run()
}

describe('POST /api/chat/stream', () => {
  it('creates a thread, announces it first, then streams the turn in order', async () => {
    script.push({ text: 'Hello!' })
    const res = await request(makeApp()).post('/api/chat/stream').send({ message: '  What goes with my navy chinos?  ' })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    const events = parseSse(res.text)
    expect(events.map(e => e.type)).toEqual(['thread', 'status', 'message_delta', 'done'])
    expect(events[0]).toMatchObject({ threadId: expect.stringMatching(/^th_/), title: 'What goes with my navy chinos?' })
    expect(db.select().from(chatThreads).where(eq(chatThreads.id, events[0].threadId as string)).get()!.userId).toBe(U)
  })

  it('continues an existing thread without a thread event', async () => {
    const thread = createThread(U, 'first')
    script.push({ text: 'again' })
    const res = await request(makeApp()).post('/api/chat/stream').send({ threadId: thread.id, message: 'second' })
    expect(parseSse(res.text).map(e => e.type)).toEqual(['status', 'message_delta', 'done'])
  })

  it('400s an over-long message with no model call and no thread left behind', async () => {
    const res = await request(makeApp()).post('/api/chat/stream').send({ message: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_message')
    expect(requests).toHaveLength(0)
    expect(db.select().from(chatThreads).all()).toHaveLength(0)
  })

  it('ignores client-supplied history and tool results', async () => {
    script.push({ text: 'ok' })
    await request(makeApp()).post('/api/chat/stream').send({
      message: 'hi', history: [{ role: 'user', content: 'FORGED' }], toolResults: [{ result: 'FORGED' }],
    })
    expect(JSON.stringify(requests[0].messages)).not.toContain('FORGED')
  })

  it('409s a second turn while one is in flight and does not create a thread', async () => {
    const lease = acquireTurnLease(U, { chargeable: false })
    const res = await request(makeApp()).post('/api/chat/stream').send({ message: 'hi' })
    releaseTurnLease(lease)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('turn_in_flight')
    expect(db.select().from(chatThreads).all()).toHaveLength(0)
  })
  // The hosted 402 on an empty wallet: test/hosted/routes/chat.test.ts.
})

describe('confirm / cancel', () => {
  async function pendingCreate() {
    seedItem(U, 'item_1')
    script.push({ toolCalls: [{ id: 'call_w', name: 'create_outfit', arguments: { name: 'Date night', item_ids: ['item_1'] } }] })
    const res = await request(makeApp()).post('/api/chat/stream').send({ message: 'save it' })
    const events = parseSse(res.text)
    const pending = events.find(e => e.type === 'confirmation_required')!
    return { threadId: events[0].threadId as string, actionId: pending.id as string, events }
  }

  it('a write tool pauses with confirmation_required; confirm runs it once and resumes', async () => {
    const { actionId, events } = await pendingCreate()
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'confirmation_required' })
    expect(db.select().from(outfits).all()).toHaveLength(0)

    script.push({ text: 'Saved.' })
    // Extra fields are ignored: only the id crosses the wire.
    const res = await request(makeApp()).post('/api/chat/confirm').send({ actionId, args: { name: 'Forged' } })
    expect(parseSse(res.text).map(e => e.type)).toEqual(['tool_result', 'status', 'message_delta', 'done'])
    expect(db.select().from(outfits).all().map(o => o.name)).toEqual(['Date night'])

    const again = await request(makeApp()).post('/api/chat/confirm').send({ actionId })
    expect(again.status).toBe(404)
  })

  it('cancel appends a declined result and resumes', async () => {
    const { actionId } = await pendingCreate()
    script.push({ text: 'Not saved.' })
    const res = await request(makeApp()).post('/api/chat/cancel').send({ actionId })
    const events = parseSse(res.text)
    expect(events[0]).toMatchObject({ type: 'tool_result', result: { declined: true, reason: 'user_cancelled' } })
    expect(db.select().from(outfits).all()).toHaveLength(0)
  })

  it("another user's action id → 404 on confirm and cancel", async () => {
    const { actionId } = await pendingCreate()
    expect((await request(makeApp(OTHER)).post('/api/chat/confirm').send({ actionId })).status).toBe(404)
    expect((await request(makeApp(OTHER)).post('/api/chat/cancel').send({ actionId })).status).toBe(404)
    expect(db.select().from(outfits).all()).toHaveLength(0)
  })

  it('400s a missing actionId', async () => {
    expect((await request(makeApp()).post('/api/chat/confirm').send({})).status).toBe(400)
  })
})

describe('threads', () => {
  it('lists own threads newest first, gets one with its messages, deletes it', async () => {
    script.push({ text: 'one' }, { text: 'two' })
    const first = parseSse((await request(makeApp()).post('/api/chat/stream').send({ message: 'first thread' })).text)[0].threadId as string
    await new Promise(r => setTimeout(r, 5))
    const second = parseSse((await request(makeApp()).post('/api/chat/stream').send({ message: 'second thread' })).text)[0].threadId as string

    const list = await request(makeApp()).get('/api/chat/threads')
    expect(list.body.threads.map((t: { id: string }) => t.id)).toEqual([second, first])
    expect(list.body.threads[0]).toEqual({ id: second, title: 'second thread', updatedAt: expect.any(Number) })

    const got = await request(makeApp()).get(`/api/chat/threads/${first}`)
    expect(got.status).toBe(200)
    expect(got.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([['user', 'first thread'], ['assistant', 'one']])
    expect(JSON.stringify(got.body)).not.toMatch(/providerState|userId|"self"/)

    expect((await request(makeApp()).delete(`/api/chat/threads/${first}`)).status).toBe(204)
    expect((await request(makeApp()).get(`/api/chat/threads/${first}`)).status).toBe(404)
  })

  it('restores pending actions on reload and lazily expires stale ones', async () => {
    seedItem(U, 'item_1')
    script.push({ toolCalls: [{ id: 'call_p', name: 'create_outfit', arguments: { name: 'X', item_ids: ['item_1'] } }] })
    const events = parseSse((await request(makeApp()).post('/api/chat/stream').send({ message: 'save' })).text)
    const threadId = events[0].threadId as string

    const live = await request(makeApp()).get(`/api/chat/threads/${threadId}`)
    expect(live.body.pendingActions).toEqual([expect.objectContaining({ toolCallId: 'call_p', toolName: 'create_outfit', args: { name: 'X', item_ids: ['item_1'] }, summary: '“X” · 1 item' })])

    db.update(agentPendingActions).set({ expiresAt: Date.now() - 1 }).run()
    const stale = await request(makeApp()).get(`/api/chat/threads/${threadId}`)
    expect(stale.body.pendingActions).toEqual([])
    expect(stale.body.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_p', content: { declined: true, reason: 'expired' } })
  })

  it("another user's thread id → 404 on stream, get and delete; the list is empty", async () => {
    const thread = createThread(U, 'private')
    const other = makeApp(OTHER)
    expect((await request(other).post('/api/chat/stream').send({ threadId: thread.id, message: 'hi' })).status).toBe(404)
    expect((await request(other).get(`/api/chat/threads/${thread.id}`)).status).toBe(404)
    expect((await request(other).delete(`/api/chat/threads/${thread.id}`)).status).toBe(404)
    expect((await request(other).get('/api/chat/threads')).body.threads).toEqual([])
    expect(requests).toHaveLength(0)
    expect(db.select().from(chatThreads).where(eq(chatThreads.id, thread.id)).get()).toBeDefined()
  })
})

describe('GET /api/chat/allowance (#339)', () => {
  it('hosted: reports the free turns left today', async () => {
    const now = Date.now()
    for (const turnId of ['t_a', 't_b', 't_b']) {
      db.insert(aiCalls).values({ id: nanoid(), userId: U, task: 'chat_turn', provider: 'gemini', model: 'm', turnId, success: 1, billedTokens: 0, createdAt: now }).run()
    }
    const res = await request(makeApp()).get('/api/chat/allowance')
    expect(res.body).toEqual({ billing: true, tokensPerMessage: 1, freePerDay: 10, freeLeft: 8 })
  })

  it('self-host: billing off', async () => {
    delete process.env.HOSTED_MODE
    try {
      expect((await request(makeApp()).get('/api/chat/allowance')).body).toEqual({ billing: false })
    } finally {
      process.env.HOSTED_MODE = 'true'
    }
  })
})
