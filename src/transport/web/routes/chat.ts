import { Router, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import {
  cancelAgentAction,
  confirmAgentAction,
  runAgentTurn,
  validateUserMessage,
  type AgentStreamEvent,
} from '../../../agent/loop.js'
import {
  CHAT_FREE_TURNS_PER_DAY,
  countTodayChatTurns,
  createThread,
  deleteThread,
  expireStalePendingActions,
  getThread,
  listMessages,
  listPendingActions,
  listThreads,
  parseToolCalls,
  type ChatMessageRow,
} from '../../../agent/chatStore.js'
import { ChatError } from '../../../agent/errors.js'
import { isHostedMode } from '../../../hostedMode.js'
import { describeAction, getTool, type AgentToolScope } from '../../../agent/tools.js'
import type { JsonValue } from '../../../ai/messages.js'
import { perUserRateLimit } from '../middleware/perUserRateLimit.js'
import { respondInsufficientTokens } from '../billingErrors.js'
import { normalizeTimeZone } from '../../../time/zone.js'

// ─── /api/chat/* (#328) ────────────────────────────────────────────────────────
//
// Mounted behind requireChatEnabled → requireSession → requireCsrfForMutations
// (server.ts). The loop (src/agent/loop.ts) owns history, billing, the turn
// lease and confirmations; this file only maps HTTP to it.
//
// SSE opens lazily on the first event. runAgentTurn throws its pre-stream
// failures (400/404/409/402/503) before emitting anything, so those still get
// a plain HTTP status and the frontend can tell them apart from a stream error.

/** Chat declares every tool; write tools still always need a Confirm tap. */
export const CHAT_SCOPES: AgentToolScope[] = ['read', 'ai', 'write']
const HEARTBEAT_MS = 15_000

const router = Router()

// Per user on turns (the expensive part) plus per IP on everything, so many
// accounts behind one address can't multiply the budget.
const turnLimiter = perUserRateLimit(60_000, 10)
const ipLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !!process.env.VITEST,
  handler: (_req, res) => { res.status(429).json({ error: 'rate_limited' }) },
})
router.use(ipLimiter)

// timeZone: the browser's IANA zone, for "today" and time of day. An invalid
// value is ignored (UTC), never a 400: it's a hint, not an input to reject.
const StreamBody = z.object({
  threadId: z.string().min(1).max(64).optional(),
  message: z.unknown(),
  timeZone: z.unknown().optional(),
})
const ActionBody = z.object({ actionId: z.string().min(1).max(64), timeZone: z.unknown().optional() })

function sse(req: Request, res: Response) {
  const controller = new AbortController()
  let heartbeat: NodeJS.Timeout | undefined
  let opened = false
  // A closed tab aborts the turn (and the model call) via the signal.
  res.on('close', () => {
    if (heartbeat) clearInterval(heartbeat)
    if (!res.writableEnded) controller.abort()
  })
  const open = () => {
    if (opened) return
    opened = true
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  }
  const send = (event: AgentStreamEvent | { type: 'thread'; threadId: string; title: string | null }) => {
    open()
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  const end = () => {
    if (heartbeat) clearInterval(heartbeat)
    res.end()
  }
  return { send, end, signal: controller.signal, get opened() { return opened } }
}

function respondError(err: unknown, res: Response, stream: ReturnType<typeof sse>): void {
  if (stream.opened) {
    // Only programming errors reach here once events flowed; the loop turns
    // model/tool failures into its own `error` event.
    console.error('[chat] stream failed:', err instanceof Error ? err.name : 'unknown error')
    stream.send({ type: 'error', error: 'Something went wrong', code: 'internal_error' })
    stream.end()
    return
  }
  if (err instanceof ChatError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return
  }
  if (respondInsufficientTokens(err, res)) return
  console.error('[chat] request failed:', err instanceof Error ? err.name : 'unknown error')
  res.status(500).json({ error: 'Something went wrong' })
}

// POST /api/chat/stream — { threadId?, message } → SSE
router.post('/stream', turnLimiter, async (req, res) => {
  const stream = sse(req, res)
  const parsed = StreamBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Invalid body' }); return }
  const userId = req.userId!
  let createdThreadId: string | null = null
  try {
    const message = validateUserMessage(parsed.data.message)
    let threadId = parsed.data.threadId
    let announce: { threadId: string; title: string | null } | null = null
    if (!threadId) {
      const thread = createThread(userId, message)
      threadId = createdThreadId = thread.id
      announce = { threadId: thread.id, title: thread.title }
    }
    await runAgentTurn({
      userId, threadId, userMessage: message, scopes: CHAT_SCOPES, signal: stream.signal,
      timeZone: normalizeTimeZone(parsed.data.timeZone),
      onEvent: event => {
        // The new thread is announced with the first real event, so a turn
        // that fails pre-stream still answers with a plain status code.
        if (announce) { stream.send({ type: 'thread', ...announce }); announce = null }
        stream.send(event)
      },
    })
    stream.end()
  } catch (err) {
    // Don't leave an empty thread behind when the first turn never started.
    if (createdThreadId && !stream.opened) deleteThread(userId, createdThreadId)
    respondError(err, res, stream)
  }
})

async function actionRoute(req: Request, res: Response, run: typeof confirmAgentAction): Promise<void> {
  const stream = sse(req, res)
  const parsed = ActionBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Invalid body' }); return }
  try {
    // Only the id crosses the wire; the stored args run.
    await run({
      userId: req.userId!, actionId: parsed.data.actionId, scopes: CHAT_SCOPES, signal: stream.signal, onEvent: stream.send,
      timeZone: normalizeTimeZone(parsed.data.timeZone),
    })
    stream.end()
  } catch (err) {
    respondError(err, res, stream)
  }
}

// POST /api/chat/confirm — { actionId } → SSE continuation
router.post('/confirm', turnLimiter, (req, res) => actionRoute(req, res, confirmAgentAction))

// POST /api/chat/cancel — { actionId } → SSE continuation
router.post('/cancel', turnLimiter, (req, res) => actionRoute(req, res, cancelAgentAction))

// GET /api/chat/allowance — the composer hint "1 token per message · N free
// today" (#339). Self-host never charges, so it reports billing off.
router.get('/allowance', (req, res) => {
  if (!isHostedMode()) { res.json({ billing: false }); return }
  const used = countTodayChatTurns(req.userId!)
  res.json({ billing: true, tokensPerMessage: 1, freePerDay: CHAT_FREE_TURNS_PER_DAY, freeLeft: Math.max(CHAT_FREE_TURNS_PER_DAY - used, 0) })
})

// GET /api/chat/threads?before=<updatedAt>&limit=<n> — newest first
router.get('/threads', (req, res) => {
  const limit = Number(req.query.limit) || 20
  const before = req.query.before !== undefined ? Number(req.query.before) : undefined
  const threads = listThreads(req.userId!, { limit, before: Number.isFinite(before) ? before : undefined })
  res.json({
    threads: threads.map(t => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })),
    nextBefore: threads.length === Math.min(Math.max(limit, 1), 100) ? threads.at(-1)!.updatedAt : null,
  })
})

/** Client view of a stored message: no providerState, no userId. */
function messageView(row: ChatMessageRow) {
  let content: unknown = row.content
  if (row.role === 'tool') {
    try { content = JSON.parse(row.content) } catch { /* keep raw */ }
  }
  return {
    id: row.id, role: row.role, content, turnId: row.turnId, createdAt: row.createdAt,
    ...(row.role === 'assistant' ? { toolCalls: parseToolCalls(row) } : {}),
    ...(row.role === 'tool' ? { toolCallId: row.toolCallId, toolName: row.toolName } : {}),
  }
}

/**
 * Shop tool rows hold product ids only (Shopify: no caching); re-read them
 * live so the cards render on reload, with delisted products flagged.
 */
async function hydratedMessageView(userId: string, row: ChatMessageRow) {
  const view = messageView(row)
  const hydrate = row.role === 'tool' && row.toolName ? getTool(row.toolName)?.hydrateView : undefined
  if (!hydrate || (view.content && typeof view.content === 'object' && 'error' in view.content)) return view
  return { ...view, content: await hydrate(view.content as JsonValue, { userId, identity: { runId: row.threadId } }) }
}

// GET /api/chat/threads/:id — messages + still-pending actions, so a reload
// restores the transcript and any Confirm / Cancel card.
router.get('/threads/:id', async (req, res) => {
  const userId = req.userId!
  const thread = getThread(userId, req.params.id)
  if (!thread) { res.status(404).json({ error: 'Not found' }); return }
  expireStalePendingActions(userId, thread.id)
  res.json({
    thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt },
    messages: await Promise.all(listMessages(userId, thread.id).map(row => hydratedMessageView(userId, row))),
    pendingActions: await Promise.all(listPendingActions(userId, thread.id).map(async pa => {
      const args = JSON.parse(pa.args) as unknown
      return {
        id: pa.id, toolCallId: pa.toolCallId, toolName: pa.toolName, args, expiresAt: pa.expiresAt,
        summary: await describeAction(pa.toolName, args, { userId, identity: { runId: thread.id } }),
      }
    })),
  })
})

// DELETE /api/chat/threads/:id — cascades to messages and pending actions
router.delete('/threads/:id', (req, res) => {
  if (!deleteThread(req.userId!, req.params.id)) { res.status(404).json({ error: 'Not found' }); return }
  res.status(204).end()
})

export default router
