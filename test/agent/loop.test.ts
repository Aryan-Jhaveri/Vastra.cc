import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { MessageRequest, ModelEvent, ModelToolCall } from '../../src/ai/messages.js'

// ─── Scripted model ────────────────────────────────────────────────────────────
// streamMessages is the only thing mocked: runInstrumented, the wallet, the DB,
// the tool registry and the adapters' validate() all run for real. Every
// request the loop sends is checked with validate(), so a history the provider
// would reject fails the test that produced it.

interface Scripted {
  text?: string
  toolCalls?: ModelToolCall[]
  /** Extra events streamed before `complete` (e.g. tool_call_delta). */
  events?: ModelEvent[]
  fail?: Error
}

const { script, requests, executeSpy } = vi.hoisted(() => ({
  script: [] as Scripted[],
  requests: [] as { request: MessageRequest; model: string }[],
  executeSpy: { fn: undefined as unknown as ReturnType<typeof vi.fn> },
}))

vi.mock('../../src/ai/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ai/client.js')>()
  const { validate } = await import('../../src/ai/messageAdapters.js')
  return {
    ...actual,
    streamMessages: (request: MessageRequest, model: string) => (async function* () {
      validate(request, !model.includes('/'), model)
      requests.push({ request: structuredClone({ ...request, signal: undefined }), model })
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      for (const event of next.events ?? []) yield event
      if (next.fail) throw next.fail
      if (next.text) yield { type: 'text_delta', text: next.text } as ModelEvent
      yield {
        type: 'complete',
        response: {
          message: { role: 'assistant', content: next.text ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) },
          usage: { tokensIn: 100, tokensOut: 20 },
          finishReason: next.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      } as ModelEvent
    })(),
  }
})

vi.mock('../../src/agent/tools.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/agent/tools.js')>()
  executeSpy.fn = vi.fn(actual.executeTool)
  return { ...actual, executeTool: (...args: Parameters<typeof actual.executeTool>) => executeSpy.fn(...args) }
})

import { db } from '../../src/db/client.js'
import { agentPendingActions, aiCalls, chatMessages, chatThreads, chatTurnLeases, collectionOutfits, collections, items, outfits, settings, users } from '../../src/db/schema.js'
import { validate } from '../../src/ai/messageAdapters.js'
import {
  buildModelMessages, cancelAgentAction, confirmAgentAction, CONTEXT_CHAR_BUDGET,
  MAX_MODEL_CALLS_PER_TURN, runAgentTurn, type AgentStreamEvent,
  assertSpendCap,
} from '../../src/agent/loop.js'
import {
  acquireTurnLease, appendMessage, createThread, deleteThread, getThread, listMessages,
  listThreads, releaseTurnLease, TURN_LEASE_MS, type ChatMessageRow,
} from '../../src/agent/chatStore.js'
import { ChatInputError, ChatNotFoundError, ChatTurnInFlightError, ChatUnavailableError } from '../../src/agent/errors.js'
import type { AgentToolScope } from '../../src/agent/tools.js'

const U = 'self'
const OTHER = 'user_chat_other'
const SCOPES: AgentToolScope[] = ['read', 'ai', 'write']
const MODEL = 'gemini-2.5-flash'

beforeAll(() => {
  if (!db.select().from(users).where(eq(users.id, OTHER)).get()) {
    db.insert(users).values({ id: OTHER, email: `${OTHER}@local.closet`, createdAt: Date.now() }).run()
  }
})

beforeEach(() => {
  script.length = 0
  requests.length = 0
  executeSpy.fn.mockClear()
  db.delete(chatTurnLeases).run()
  db.delete(chatThreads).run()
  db.delete(aiCalls).run()
  db.delete(collectionOutfits).run()
  db.delete(collections).run()
  db.delete(outfits).run()
  db.delete(items).run()
  db.delete(settings).where(eq(settings.key, 'userSizes')).run()
  db.delete(settings).where(eq(settings.key, 'sizesAgentContext')).run()
  process.env.HOSTED_MODE = 'true'
  delete process.env.AGENT_MODEL
})

afterEach(() => {
  process.env.HOSTED_MODE = 'true'
})

function seedItem(userId: string, id: string) {
  const now = Date.now()
  db.insert(items).values({ id, userId, imageUri: `images/items/${id}.jpg`, category: 'tops', createdAt: now, updatedAt: now }).run()
  return id
}

function call(name: string, args: Record<string, unknown> = {}, id = `call_${nanoid(6)}`): ModelToolCall {
  return { id, name, arguments: args as ModelToolCall['arguments'] }
}

async function turn(threadId: string, message: string, userId = U) {
  const events: AgentStreamEvent[] = []
  await runAgentTurn({ userId, threadId, userMessage: message, scopes: SCOPES, onEvent: e => { events.push(e) } })
  return events
}

async function confirm(actionId: string, userId = U) {
  const events: AgentStreamEvent[] = []
  await confirmAgentAction({ userId, actionId, scopes: SCOPES, onEvent: e => { events.push(e) } })
  return events
}

async function cancel(actionId: string, userId = U) {
  const events: AgentStreamEvent[] = []
  await cancelAgentAction({ userId, actionId, scopes: SCOPES, onEvent: e => { events.push(e) } })
  return events
}

/** Pretend `n` chargeable turns already ran today, so the next one costs 1. */
function useFreeAllowance(userId: string, n = 10) {
  for (let i = 0; i < n; i++) {
    db.insert(aiCalls).values({
      id: nanoid(), userId, task: 'chat_turn', provider: 'gemini', model: MODEL, turnId: `old_${i}`,
      success: 1, billedTokens: 0, createdAt: Date.now(),
    }).run()
  }
}

function chatCalls() {
  return db.select().from(aiCalls).where(eq(aiCalls.task, 'chat_turn')).all().filter(r => !r.turnId?.startsWith('old_'))
}

// ─── Loop ──────────────────────────────────────────────────────────────────────

describe('runAgentTurn — loop', () => {
  it('executes a read tool, feeds the result back as a tool message, then finishes', async () => {
    seedItem(U, 'item_navy')
    const thread = createThread(U, 'What tops do I have?')
    script.push({ toolCalls: [call('search_closet', { category: 'tops' }, 'call_1')] }, { text: 'You have one top.' })

    const events = await turn(thread.id, 'What tops do I have?')

    expect(events.map(e => e.type)).toEqual(['status', 'tool_preview', 'tool_result', 'status', 'message_delta', 'done'])
    const toolResult = events.find(e => e.type === 'tool_result') as Extract<AgentStreamEvent, { type: 'tool_result'; result: unknown }>
    expect(toolResult.result).toMatchObject({ total: 1, results: [{ id: 'item_navy' }] })
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop', steps: 2 })

    const second = requests[1].request.messages
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_1', name: 'search_closet', content: { total: 1 } })
    expect(listMessages(U, thread.id).map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('stops at the model-call cap with done/length instead of crashing', async () => {
    const thread = createThread(U, 'loop forever')
    for (let i = 0; i < MAX_MODEL_CALLS_PER_TURN + 2; i++) script.push({ toolCalls: [call('list_collections')] })

    const events = await turn(thread.id, 'loop forever')

    expect(requests).toHaveLength(MAX_MODEL_CALLS_PER_TURN)
    expect(events).toContainEqual({ type: 'status', step: MAX_MODEL_CALLS_PER_TURN, status: 'step_limit' })
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'length', steps: MAX_MODEL_CALLS_PER_TURN })
    // The thread is still usable: every call has a result.
    script.length = 0
    script.push({ text: 'ok' })
    await turn(thread.id, 'next')
    expect(requests).toHaveLength(MAX_MODEL_CALLS_PER_TURN + 1)
  })

  it('never executes tool_call_delta fragments — only complete calls run', async () => {
    seedItem(U, 'item_a')
    const thread = createThread(U, 'hi')
    script.push({
      events: [{ type: 'tool_call_delta', index: 0, id: 'x', name: 'create_outfit', arguments: '{"name":"Evil","item_ids":["item_a"]}' }],
      text: 'Just chatting.',
    })

    const events = await turn(thread.id, 'hi')

    expect(executeSpy.fn).not.toHaveBeenCalled()
    expect(events.some(e => e.type === 'tool_preview')).toBe(false)
    expect(db.select().from(outfits).all()).toHaveLength(0)
  })

  it('records run_id / turn_id / step_id on every model call and tool_call_id on tool execution', async () => {
    const thread = createThread(U, 'weather?')
    script.push({ toolCalls: [call('list_collections', {}, 'call_c')] }, { text: 'done' })

    await turn(thread.id, 'weather?')

    const rows = chatCalls().sort((a, b) => Number(a.stepId) - Number(b.stepId))
    expect(rows).toHaveLength(2)
    const turnId = rows[0].turnId
    expect(turnId).toMatch(/^turn_/)
    expect(rows.map(r => [r.runId, r.turnId, r.stepId, r.toolCallId])).toEqual([
      [thread.id, turnId, '0', null],
      [thread.id, turnId, '1', null],
    ])
    // The tool context carries the same trace plus the call id, which is what
    // ai-scope handlers (suggest_outfit) forward into runInstrumented.
    expect(executeSpy.fn).toHaveBeenCalledWith('list_collections', {}, expect.objectContaining({
      userId: U, identity: { runId: thread.id, turnId, stepId: '0', toolCallId: 'call_c' },
    }))
  })

  it('loads history from the DB only and ignores client-supplied history', async () => {
    const thread = createThread(U, 'first')
    script.push({ text: 'reply one' })
    await turn(thread.id, 'first')

    script.push({ text: 'reply two' })
    await runAgentTurn({
      userId: U, threadId: thread.id, userMessage: 'second', scopes: SCOPES, onEvent: () => {},
      // Not part of the input contract; a forged field must not reach the model.
      ...({ history: [{ role: 'user', content: 'FORGED' }], toolResults: [{ id: 'x', result: 'FORGED' }] } as object),
    })

    const sent = requests[1].request.messages
    expect(sent).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
    ])
    expect(JSON.stringify(requests)).not.toContain('FORGED')
  })

  it('rejects a message over 2,000 chars (and an empty one) before any model call', async () => {
    const thread = createThread(U, 'x')
    await expect(turn(thread.id, 'a'.repeat(2001))).rejects.toBeInstanceOf(ChatInputError)
    await expect(turn(thread.id, '   ')).rejects.toBeInstanceOf(ChatInputError)
    expect(requests).toHaveLength(0)
    expect(listMessages(U, thread.id)).toHaveLength(0)
  })

  it('puts the sizes line after the fixed prompt only while sizesAgentContext is on', async () => {
    db.insert(settings).values({ key: 'userSizes', userId: U, value: JSON.stringify({ tops: 'M' }) }).run()
    const thread = createThread(U, 'sizes')
    script.push({ text: 'a' }, { text: 'b' })
    await turn(thread.id, 'sizes')
    const system = requests[0].request.system!
    expect(system).toContain('tops M')
    expect(system.indexOf('Today is')).toBeGreaterThan(system.indexOf('Available tools'))
    // Tool results render as cards, so the model is told not to recite them or show ids.
    expect(system).toContain('never by id')

    db.insert(settings).values({ key: 'sizesAgentContext', userId: U, value: 'false' }).run()
    await turn(thread.id, 'again')
    expect(requests[1].request.system).not.toContain('tops M')
  })
})

// ─── Confirmations ─────────────────────────────────────────────────────────────

// The daily chat spend cap compares ai_calls cost (USD × 100,000) against
// CHAT_DAILY_SPEND_CAP_CENTS. It used to multiply cents by 100, which tripped
// the cap at a tenth of the configured spend.
describe('chat daily spend cap', () => {
  function spendToday(usd: number) {
    db.insert(aiCalls).values({
      id: nanoid(), userId: U, task: 'chat_turn', provider: 'gemini', model: MODEL, turnId: 'old_spend',
      success: 1, billedTokens: 0, wholesaleCostCentsX100: Math.round(usd * 100_000), createdAt: Date.now(),
    }).run()
  }
  const defaultCap = process.env.CHAT_DAILY_SPEND_CAP_CENTS
  afterEach(() => {
    if (defaultCap === undefined) delete process.env.CHAT_DAILY_SPEND_CAP_CENTS
    else process.env.CHAT_DAILY_SPEND_CAP_CENTS = defaultCap
  })

  it('allows spend below the cap: $0.60 of a $1.00 cap', () => {
    process.env.CHAT_DAILY_SPEND_CAP_CENTS = '100'
    spendToday(0.6)
    expect(() => assertSpendCap()).not.toThrow()
  })

  it('trips at the cap: $1.00 of a $1.00 cap', () => {
    process.env.CHAT_DAILY_SPEND_CAP_CENTS = '100'
    spendToday(1)
    expect(() => assertSpendCap()).toThrow(ChatUnavailableError)
  })

  it('fails closed when hosted and no cap is configured', () => {
    delete process.env.CHAT_DAILY_SPEND_CAP_CENTS
    expect(() => assertSpendCap()).toThrow(ChatUnavailableError)
    process.env.CHAT_DAILY_SPEND_CAP_CENTS = 'not-a-number'
    expect(() => assertSpendCap()).toThrow(ChatUnavailableError)
  })

  it('counts model calls made by chat tools (they carry the turn id), not only chat_turn', () => {
    process.env.CHAT_DAILY_SPEND_CAP_CENTS = '100'
    spendToday(0.6)
    db.insert(aiCalls).values({
      id: nanoid(), userId: U, task: 'suggest', provider: 'gemini', model: MODEL, turnId: 'turn_tool', toolCallId: 'call_t',
      success: 1, billedTokens: 0, wholesaleCostCentsX100: Math.round(0.4 * 100_000), createdAt: Date.now(),
    }).run()
    // Spend outside chat (no turn id) does not count.
    db.insert(aiCalls).values({
      id: nanoid(), userId: U, task: 'suggest', provider: 'gemini', model: MODEL,
      success: 1, billedTokens: 0, wholesaleCostCentsX100: Math.round(5 * 100_000), createdAt: Date.now(),
    }).run()
    expect(() => assertSpendCap()).toThrow(ChatUnavailableError)
  })

  it('never applies when self-hosted', () => {
    delete process.env.HOSTED_MODE
    process.env.CHAT_DAILY_SPEND_CAP_CENTS = '100'
    spendToday(5)
    expect(() => assertSpendCap()).not.toThrow()
  })
})

describe('write tools and confirmations', () => {
  function pendingIds(events: AgentStreamEvent[]) {
    return events.filter(e => e.type === 'confirmation_required').map(e => (e as { id: string }).id)
  }

  it('pauses a write tool until confirm, runs the stored args once, then resumes the turn', async () => {
    seedItem(U, 'item_1')
    seedItem(U, 'item_2')
    const thread = createThread(U, 'save it')
    script.push({ toolCalls: [call('create_outfit', { name: 'Date night', item_ids: ['item_1', 'item_2'] }, 'call_w')] })

    const events = await turn(thread.id, 'save it')

    const [actionId] = pendingIds(events)
    expect(actionId).toMatch(/^pa_/)
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'confirmation_required' })
    expect(db.select().from(outfits).all()).toHaveLength(0)
    expect(executeSpy.fn).not.toHaveBeenCalled()

    script.push({ text: 'Saved "Date night".' })
    const resumed = await confirm(actionId)

    const created = db.select().from(outfits).all()
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ userId: U, name: 'Date night' })
    expect(resumed.map(e => e.type)).toEqual(['tool_result', 'status', 'message_delta', 'done'])
    expect(requests.at(-1)!.request.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call_w', name: 'create_outfit' })
    // The resumed model call continues the same turn with the next step id.
    const steps = chatCalls().map(r => r.stepId).sort()
    expect(steps).toEqual(['0', '1'])

    // Single use.
    await expect(confirm(actionId)).rejects.toBeInstanceOf(ChatNotFoundError)
    expect(db.select().from(outfits).all()).toHaveLength(1)
  })

  it('confirm runs the stored args, never anything tampered with in the event stream', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'Original', item_ids: ['item_1'] })] })
    const events = await turn(thread.id, 'save')
    const pending = events.find(e => e.type === 'confirmation_required') as { id: string; args: { name: string } }
    pending.args.name = 'Tampered' // client-side mutation has no path back to the server

    script.push({ text: 'ok' })
    await confirm(pending.id)
    expect(db.select().from(outfits).all()[0].name).toBe('Original')
  })

  it('is user-bound: another user confirming or cancelling the action gets 404', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'Mine', item_ids: ['item_1'] })] })
    const [actionId] = pendingIds(await turn(thread.id, 'save'))

    await expect(confirm(actionId, OTHER)).rejects.toBeInstanceOf(ChatNotFoundError)
    await expect(cancel(actionId, OTHER)).rejects.toBeInstanceOf(ChatNotFoundError)
    expect(db.select().from(outfits).all()).toHaveLength(0)
    expect(db.select().from(agentPendingActions).where(eq(agentPendingActions.id, actionId)).get()!.status).toBe('pending')
  })

  it('an expired action is declined, not run, and the next model call still validates', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'Late', item_ids: ['item_1'] }, 'call_late')] })
    const [actionId] = pendingIds(await turn(thread.id, 'save'))
    db.update(agentPendingActions).set({ expiresAt: Date.now() - 1 }).where(eq(agentPendingActions.id, actionId)).run()

    script.push({ text: 'That expired — want me to try again?' })
    const events = await confirm(actionId)

    expect(db.select().from(outfits).all()).toHaveLength(0)
    expect(events[0]).toEqual({ type: 'tool_result', id: 'call_late', name: 'create_outfit', result: { declined: true, reason: 'expired' } })
    expect(db.select().from(agentPendingActions).where(eq(agentPendingActions.id, actionId)).get()!.status).toBe('expired')
    await expect(confirm(actionId)).rejects.toBeInstanceOf(ChatNotFoundError)
  })

  it('cancel appends { declined: true } and the thread keeps working', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'Nope', item_ids: ['item_1'] }, 'call_n')] })
    const [actionId] = pendingIds(await turn(thread.id, 'save'))

    script.push({ text: 'Okay, not saved.' })
    const events = await cancel(actionId)
    expect(events[0]).toEqual({ type: 'tool_result', id: 'call_n', name: 'create_outfit', result: { declined: true, reason: 'user_cancelled' } })
    expect(db.select().from(outfits).all()).toHaveLength(0)

    script.push({ text: 'Sure.' })
    await turn(thread.id, 'something else')
    expect(requests.at(-1)!.request.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
  })

  it('two write calls in one step: two actions, resume only after both are resolved', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save two')
    script.push({ toolCalls: [
      call('list_collections', {}, 'call_r'),
      call('create_outfit', { name: 'A', item_ids: ['item_1'] }, 'call_a'),
      call('create_outfit', { name: 'B', item_ids: ['item_1'] }, 'call_b'),
    ] })
    const events = await turn(thread.id, 'save two')
    const [first, second] = pendingIds(events)
    expect(second).toBeDefined()
    // The read call in the same step ran before the pause.
    expect(events.filter(e => e.type === 'tool_result').map(e => (e as { id: string }).id)).toEqual(['call_r'])

    const afterFirst = await confirm(first)
    expect(requests).toHaveLength(1) // no model call yet
    expect(afterFirst.filter(e => e.type === 'confirmation_required').map(e => (e as { id: string }).id)).toEqual([second])
    expect(afterFirst.at(-1)).toMatchObject({ type: 'done', finishReason: 'confirmation_required' })

    script.push({ text: 'Saved A; skipped B.' })
    await cancel(second)
    expect(requests).toHaveLength(2)
    expect(db.select().from(outfits).all().map(o => o.name)).toEqual(['A'])
  })

  it('a new message declines still-pending actions so the history stays valid', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'X', item_ids: ['item_1'] }, 'call_x')] })
    const [actionId] = pendingIds(await turn(thread.id, 'save'))

    script.push({ text: 'Changed topic.' })
    await turn(thread.id, 'never mind, what about shoes?')

    expect(db.select().from(agentPendingActions).where(eq(agentPendingActions.id, actionId)).get()!.status).toBe('superseded')
    expect(requests.at(-1)!.request.messages).toContainEqual({ role: 'tool', toolCallId: 'call_x', name: 'create_outfit', content: { declined: true, reason: 'superseded' } })
    await expect(confirm(actionId)).rejects.toBeInstanceOf(ChatNotFoundError)
  })
})

// ─── Tenancy ───────────────────────────────────────────────────────────────────

describe('turn time limit on confirmed actions (#328 threat #10)', () => {
  it('a confirmed tool runs under the 60 s turn timeout even when the caller passes no signal', async () => {
    seedItem(U, 'item_1')
    seedItem(U, 'item_2')
    const thread = createThread(U, 'save it')
    script.push({ toolCalls: [call('create_outfit', { name: 'Late', item_ids: ['item_1', 'item_2'] }, 'call_t')] })
    const events = await turn(thread.id, 'save it')
    const actionId = (events.find(e => e.type === 'confirmation_required') as { id: string }).id

    // The first timeout created is the confirmed tool's (runSteps comes after):
    // hand it a pre-fired one and check the tool sees it.
    const fired = new AbortController()
    fired.abort(new DOMException('timed out', 'TimeoutError'))
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => fired.signal)
    let seen: AbortSignal | undefined
    executeSpy.fn.mockImplementationOnce(async (_name: string, _args: unknown, ctx: { signal?: AbortSignal }) => { seen = ctx.signal; return { ok: true } })
    script.push({ text: 'done' })
    await confirmAgentAction({ userId: U, actionId, scopes: SCOPES, onEvent: () => {} }).catch(() => {})

    expect(timeoutSpy).toHaveBeenCalledWith(60_000)
    expect(seen?.aborted).toBe(true)
    timeoutSpy.mockRestore()
  })
})

describe('cross-user isolation', () => {
  it("another user's thread id is not found on every path", async () => {
    const thread = createThread(U, 'private')
    script.push({ text: 'hi' })
    await turn(thread.id, 'private')

    await expect(turn(thread.id, 'let me in', OTHER)).rejects.toBeInstanceOf(ChatNotFoundError)
    expect(getThread(OTHER, thread.id)).toBeUndefined()
    expect(listThreads(OTHER)).toHaveLength(0)
    expect(listMessages(OTHER, thread.id)).toHaveLength(0)
    expect(deleteThread(OTHER, thread.id)).toBe(false)
    expect(() => appendMessage(OTHER, thread.id, { role: 'user', turnId: 't', content: 'x' })).toThrow()
    expect(getThread(U, thread.id)).toBeDefined()
    expect(requests).toHaveLength(1)
  })

  it('deleting a thread cascades to messages and pending actions', async () => {
    seedItem(U, 'item_1')
    const thread = createThread(U, 'save')
    script.push({ toolCalls: [call('create_outfit', { name: 'X', item_ids: ['item_1'] })] })
    await turn(thread.id, 'save')

    expect(deleteThread(U, thread.id)).toBe(true)
    expect(db.select().from(chatMessages).where(eq(chatMessages.threadId, thread.id)).all()).toHaveLength(0)
    expect(db.select().from(agentPendingActions).where(eq(agentPendingActions.threadId, thread.id)).all()).toHaveLength(0)
  })

  it('requires a userId at runtime', async () => {
    expect(() => createThread('', 'x')).toThrow('Authenticated userId is required')
    await expect(runAgentTurn({ userId: '', threadId: 'th', userMessage: 'x', scopes: SCOPES, onEvent: () => {} })).rejects.toThrow('Authenticated userId is required')
  })
})

// ─── Billing ───────────────────────────────────────────────────────────────────
// Hosted wallet charging lives in test/hosted/agent/loop-billing.test.ts.

describe('billing', () => {
  it('self-host records billedTokens=0 even past the free allowance', async () => {
    delete process.env.HOSTED_MODE
    useFreeAllowance(U)
    const thread = createThread(U, 'hi')
    script.push({ text: 'hello' })
    await turn(thread.id, 'hi')
    expect(chatCalls().map(r => [r.success, r.billedTokens])).toEqual([[1, 0]])
  })
})

// ─── Lease ─────────────────────────────────────────────────────────────────────

describe('one turn in flight per user', () => {
  it('a second concurrent turn gets ChatTurnInFlightError (409); an expired lease frees the user', async () => {
    const lease = acquireTurnLease(U, { chargeable: false })
    const thread = createThread(U, 'hi')
    await expect(turn(thread.id, 'hi')).rejects.toBeInstanceOf(ChatTurnInFlightError)
    await expect(turn(thread.id, 'hi')).rejects.toMatchObject({ status: 409 })
    // Other users are unaffected.
    expect(() => releaseTurnLease(acquireTurnLease(OTHER, { chargeable: false }))).not.toThrow()

    const later = Date.now() + TURN_LEASE_MS + 1
    const takeover = acquireTurnLease(U, { chargeable: false }, later)
    // The crashed turn's token can no longer release the new owner's lease.
    releaseTurnLease(lease)
    expect(db.select().from(chatTurnLeases).where(and(eq(chatTurnLeases.userId, U), eq(chatTurnLeases.token, takeover.token))).get()).toBeDefined()
    releaseTurnLease(takeover)

    script.push({ text: 'hi' })
    await turn(thread.id, 'hi')
    expect(db.select().from(chatTurnLeases).all()).toHaveLength(0)
  })
})

// ─── History rebuild + trimming ────────────────────────────────────────────────

describe('buildModelMessages', () => {
  const declared = new Set(['search_closet', 'list_collections', 'create_outfit'])
  let seq = 0
  function row(turnId: string, fields: Partial<ChatMessageRow> & Pick<ChatMessageRow, 'role'>): ChatMessageRow {
    seq++
    return {
      id: `m${seq}`, threadId: 't', userId: U, turnId, content: '', toolCalls: null, providerState: null,
      toolCallId: null, toolName: null, seq, createdAt: seq, ...fields,
    }
  }
  function toolTurn(turnId: string, resultSize: number): ChatMessageRow[] {
    const id = `c_${turnId}`
    return [
      row(turnId, { role: 'user', content: `question ${turnId}` }),
      row(turnId, { role: 'assistant', content: '', toolCalls: JSON.stringify([{ id, name: 'search_closet', arguments: {} }]) }),
      row(turnId, { role: 'tool', toolCallId: id, toolName: 'search_closet', content: JSON.stringify({ blob: 'x'.repeat(resultSize) }) }),
      row(turnId, { role: 'assistant', content: `answer ${turnId}` }),
    ]
  }

  it('trims on whole turns: a tool call and its result are never separated', () => {
    const rows = Array.from({ length: 30 }, (_, i) => toolTurn(`t${i}`, 3_000)).flat()
    const messages = buildModelMessages(rows, declared, MODEL)

    expect(() => validate({ messages, tools: [...declared].map(name => ({ name, parameters: { type: 'object' } })) }, true, MODEL)).not.toThrow()
    expect(messages[0]).toEqual({ role: 'user', content: expect.stringMatching(/^question t\d+$/) })
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'answer t29' })
    expect(messages.length).toBeLessThan(rows.length)
    expect(messages.length % 4).toBe(0)
    const chars = messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
    expect(chars).toBeLessThan(CONTEXT_CHAR_BUDGET * 1.2)
  })

  it('always keeps the newest turn even when it alone exceeds the budget', () => {
    const rows = [...toolTurn('old', 10), ...toolTurn('huge', CONTEXT_CHAR_BUDGET * 2)]
    const messages = buildModelMessages(rows, declared, MODEL)
    expect(messages[0]).toEqual({ role: 'user', content: 'question huge' })
    expect(messages).toHaveLength(4)
  })

  it('repairs interrupted calls, drops undeclared tools, and replays providerState only for the same model', () => {
    const state = JSON.stringify({ provider: 'gemini', model: MODEL, parts: [{ functionCall: { id: 'g1', name: 'search_closet', args: {} } }] })
    const rows = [
      row('a', { role: 'user', content: 'q' }),
      row('a', { role: 'assistant', content: 'checking', providerState: state, toolCalls: JSON.stringify([{ id: 'c1', name: 'search_closet', arguments: {} }]) }),
      // crash: no tool row for c1
      row('b', { role: 'user', content: 'q2' }),
      row('b', { role: 'assistant', content: 'old tool', toolCalls: JSON.stringify([{ id: 'c2', name: 'set_my_size', arguments: {} }]) }),
      row('b', { role: 'tool', toolCallId: 'c2', toolName: 'set_my_size', content: '{"ok":true}' }),
      row('b', { role: 'tool', toolCallId: 'ghost', toolName: 'search_closet', content: '{}' }),
    ]
    const same = buildModelMessages(rows, declared, MODEL)
    expect(same).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'search_closet', arguments: {} }], providerState: JSON.parse(state) },
      { role: 'tool', toolCallId: 'c1', name: 'search_closet', content: { error: 'Tool result unavailable' } },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'old tool' },
    ])
    const tools = [...declared].map(name => ({ name, parameters: { type: 'object' } }))
    expect(() => validate({ messages: same, tools }, true, MODEL)).not.toThrow()

    const other = buildModelMessages(rows, declared, 'gemini-3-flash')
    expect(other[1]).not.toHaveProperty('providerState')
    expect(() => validate({ messages: other, tools }, true, 'gemini-3-flash')).not.toThrow()
  })
})

// ─── Ask transcripts (#337) ────────────────────────────────────────────────────
// Scripted replays of the two real sessions that went wrong. The model's moves
// are scripted, so these pin what the server does with them: bad proposals
// never reach a Confirm card and go back to the model as errors, good ones
// pause for a single confirmation, and nothing is saved without it.

describe('Ask transcripts (#337)', () => {
  function seedAs(id: string, category: string, primaryColor = 'red') {
    const now = Date.now()
    db.insert(items).values({ id, userId: U, imageUri: `images/items/${id}.jpg`, category, primaryColor, createdAt: now, updatedAt: now }).run()
    return id
  }

  it('the system prompt carries the act-first, composition and no-text-confirmation rules', async () => {
    const thread = createThread(U, 'prompt')
    script.push({ text: 'hi' })
    await turn(thread.id, 'hi')
    const system = requests[0].request.system!
    expect(system).toContain('Do not ask the user which items to use or what to call something')
    expect(system).toContain('Never ask "shall I save it?" in text')
    expect(system).toContain('one item per slot')
    expect(system).toContain('"All red" means the best all-red look, not every red item')
    expect(system).toContain('If no tool can do what the user asks, say so plainly')
    expect(system).toContain('Prefer saved outfits')
    expect(system).toContain('get_forecast')
    expect(system).toContain('never ask the user for them')
    for (const name of ['create_collection', 'add_outfits_to_collection', 'update_outfit', 'get_forecast']) {
      expect(system).toContain(name)
    }
  })

  it('"Create a new outfit for me, that\'s all red": a 9-item outfit is bounced, a real look gets one Confirm card', async () => {
    const reds = [
      seedAs('r_tee1', 'tops'), seedAs('r_tee2', 'tops'), seedAs('r_tee3', 'tops'),
      seedAs('r_shirt1', 'tops'), seedAs('r_shirt2', 'tops'), seedAs('r_tank', 'tops'),
      seedAs('r_jacket', 'outerwear'), seedAs('r_sneakers', 'shoes'), seedAs('r_pants', 'bottoms'),
    ]
    const thread = createThread(U, 'red')
    script.push(
      { toolCalls: [call('search_closet', { color: 'red' }, 'c_search')] },
      { toolCalls: [call('create_outfit', { name: 'Everything red', item_ids: reds }, 'c_all')] },
      { toolCalls: [call('create_outfit', { name: 'Red, head to toe', item_ids: ['r_tee1', 'r_tee2', 'r_tank', 'r_pants', 'r_sneakers'] }, 'c_tops')] },
      { toolCalls: [call('create_outfit', { name: 'Red, head to toe', item_ids: ['r_tee1', 'r_pants', 'r_jacket', 'r_sneakers'] }, 'c_ok')] },
    )

    const events = await turn(thread.id, "Create a new outfit for me, that's all red")

    // Both bad proposals come back as tool errors; neither became a card.
    const errors = events.filter(e => e.type === 'tool_result' && 'error' in e) as { id: string; error: string }[]
    expect(errors.map(e => e.id)).toEqual(['c_all', 'c_tops'])
    expect(errors[0].error).toMatch(/Invalid input/)
    expect(errors[1].error).toMatch(/at most 2 tops/)
    const confirms = events.filter(e => e.type === 'confirmation_required')
    expect(confirms).toEqual([expect.objectContaining({ toolCallId: 'c_ok', summary: '“Red, head to toe” · 4 items' })])
    expect(db.select().from(agentPendingActions).all().map(a => a.toolCallId)).toEqual(['c_ok'])
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'confirmation_required' })
    // The model saw the rejection before its next attempt.
    expect(requests[2].request.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c_all' })
    // No text-only "shall I save?" turn: every model step before the card was a tool call.
    expect(events.some(e => e.type === 'message_delta')).toBe(false)
    expect(db.select().from(outfits).all()).toHaveLength(0)

    script.push({ text: 'Saved.' })
    const actionId = (confirms[0] as { id: string }).id
    await confirm(actionId)
    const saved = db.select().from(outfits).all()
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0].itemIds)).toHaveLength(4)
  })

  it('"Create a collection so I remember what to pack": a copy of a saved outfit is bounced, the collection points at the saved one', async () => {
    const workItems = [seedAs('w_shirt', 'tops', 'white'), seedAs('w_trousers', 'bottoms', 'grey'), seedAs('w_loafers', 'shoes', 'brown')]
    const now = Date.now()
    db.insert(outfits).values({ id: 'saved_work', userId: U, name: 'Sophisticated Professional', itemIds: JSON.stringify(workItems), season: '[]', tags: '[]', createdAt: now, timesWorn: 0 }).run()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ daily: {
      time: ['2026-10-02', '2026-10-03', '2026-10-04'], temperature_2m_max: [14, 12, 15], temperature_2m_min: [6, 5, 7],
      weather_code: [3, 61, 0], precipitation_probability_max: [10, 80, 0], precipitation_sum: [0, 4, 0], wind_speed_10m_max: [12, 20, 8],
    } }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const thread = createThread(U, 'trip')
    script.push(
      { toolCalls: [call('get_forecast', { lat: 43.65, lon: -79.38, start_date: '2026-10-02', days: 3 }, 'c_fc'), call('list_outfits', {}, 'c_lo')] },
      { toolCalls: [call('create_outfit', { name: 'Toronto Work Day', item_ids: [...workItems].reverse() }, 'c_copy')] },
      { toolCalls: [call('create_collection', { name: 'Toronto trip', outfit_ids: ['saved_work'] }, 'c_coll')] },
    )
    const events = await turn(thread.id, 'Create a collection so I remember what to pack')
    fetchSpy.mockRestore()

    const forecast = events.find(e => e.type === 'tool_result' && e.id === 'c_fc') as { result: { days: unknown[] } }
    expect(forecast.result.days).toHaveLength(3)
    const copy = events.find(e => e.type === 'tool_result' && e.id === 'c_copy') as { error: string }
    expect(copy.error).toMatch(/same items as the saved outfit "Sophisticated Professional"/)
    const confirms = events.filter(e => e.type === 'confirmation_required')
    expect(confirms).toEqual([expect.objectContaining({ toolCallId: 'c_coll', summary: '“Toronto trip” · 1 outfit' })])

    script.push({ text: 'Made "Toronto trip".' })
    await confirm((confirms[0] as { id: string }).id)
    expect(db.select().from(outfits).all()).toHaveLength(1) // no copies
    const coll = db.select().from(collections).all()
    expect(coll.map(c => c.name)).toEqual(['Toronto trip'])
    expect(db.select().from(collectionOutfits).all().map(r => r.outfitId)).toEqual(['saved_work'])
  })

  it('a valid write alongside a rejected one still pauses for the valid one', async () => {
    seedAs('m_top', 'tops'); seedAs('m_pants', 'bottoms'); seedAs('m_shoes', 'shoes'); seedAs('m_shoes2', 'shoes')
    const thread = createThread(U, 'mixed')
    script.push({ toolCalls: [
      call('create_outfit', { name: 'Good', item_ids: ['m_top', 'm_pants', 'm_shoes'] }, 'c_good'),
      call('create_outfit', { name: 'Bad', item_ids: ['m_top', 'm_shoes', 'm_shoes2'] }, 'c_bad'),
    ] })
    const events = await turn(thread.id, 'two outfits')
    expect(events.filter(e => e.type === 'confirmation_required').map(e => (e as { toolCallId: string }).toolCallId)).toEqual(['c_good'])
    expect(events.find(e => e.type === 'tool_result' && e.id === 'c_bad')).toMatchObject({ error: expect.stringMatching(/at most 1 shoes/) })
    // Resuming later still validates: the rejected call already has its stored result.
    script.push({ text: 'ok' })
    await confirm((events.find(e => e.type === 'confirmation_required') as { id: string }).id)
    expect(db.select().from(outfits).all().map(o => o.name)).toEqual(['Good'])
  })
})
