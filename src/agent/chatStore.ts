import { and, asc, desc, eq, gte, isNotNull, like, lt, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, getSqlite } from '../db/client.js'
import { agentPendingActions, aiCalls, chatMessages, chatThreads } from '../db/schema.js'
import { requireUserId } from '../db/queries.js'
import type { JsonObject, JsonValue, ModelToolCall } from '../ai/messages.js'
import { ChatTurnInFlightError } from './errors.js'
import { startOfUtcDayMs } from '../time/utcDay.js'
import { PARTIAL_OUTPUT_ERROR_PREFIX } from '../ai/instrumented.js'

// ─── Chat persistence (#318) ───────────────────────────────────────────────────
//
// Every function takes `userId` and validates it at runtime. A foreign thread or
// action id behaves exactly like a missing one (undefined / false), so routes
// answer 404 and never leak existence.

export type ChatThreadRow = typeof chatThreads.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
export type PendingActionRow = typeof agentPendingActions.$inferSelect
export type PendingActionStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'superseded'

export const THREAD_TITLE_MAX = 60
export const PENDING_ACTION_TTL_MS = 5 * 60_000
/** Longer than the 60 s turn timeout, so a live turn never loses its lease. */
export const TURN_LEASE_MS = 90_000

// ─── Threads ───────────────────────────────────────────────────────────────────

export function threadTitle(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, ' ').trim()
  return flat.length > THREAD_TITLE_MAX ? `${flat.slice(0, THREAD_TITLE_MAX - 1).trimEnd()}…` : flat
}

export function createThread(userId: string, firstMessage: string, now = Date.now()): ChatThreadRow {
  requireUserId(userId)
  const row = { id: `th_${nanoid()}`, userId, title: threadTitle(firstMessage), createdAt: now, updatedAt: now }
  db.insert(chatThreads).values(row).run()
  return row
}

export function getThread(userId: string, threadId: string): ChatThreadRow | undefined {
  requireUserId(userId)
  return db.select().from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .get()
}

/** Newest first. `before` is an `updatedAt` cursor from the previous page. */
export function listThreads(userId: string, opts: { limit?: number; before?: number } = {}): ChatThreadRow[] {
  requireUserId(userId)
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  return db.select().from(chatThreads)
    .where(and(
      eq(chatThreads.userId, userId),
      opts.before !== undefined ? lt(chatThreads.updatedAt, opts.before) : undefined,
    ))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit)
    .all()
}

/** Cascades to messages and pending actions. False for a foreign or missing id. */
export function deleteThread(userId: string, threadId: string): boolean {
  requireUserId(userId)
  return db.delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .run().changes === 1
}

// ─── Messages ──────────────────────────────────────────────────────────────────

export type NewChatMessage =
  | { role: 'user'; turnId: string; content: string }
  | { role: 'assistant'; turnId: string; content: string; toolCalls?: ModelToolCall[]; providerState?: JsonObject }
  | { role: 'tool'; turnId: string; toolCallId: string; toolName: string; content: JsonValue }

/** Appends in thread order (monotonic `seq`) and bumps the thread's updatedAt. */
export function appendMessage(userId: string, threadId: string, message: NewChatMessage, now = Date.now()): ChatMessageRow {
  requireUserId(userId)
  return db.transaction(tx => {
    const thread = tx.select({ id: chatThreads.id }).from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId))).get()
    if (!thread) throw new Error(`Chat thread ${threadId} not found`)
    const { seq } = tx.select({ seq: sql<number>`COALESCE(MAX(${chatMessages.seq}), 0)` }).from(chatMessages)
      .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId))).get()!
    const row: ChatMessageRow = {
      id: `msg_${nanoid()}`, threadId, userId, turnId: message.turnId, role: message.role,
      content: message.role === 'tool' ? JSON.stringify(message.content) : message.content,
      toolCalls: message.role === 'assistant' && message.toolCalls?.length ? JSON.stringify(message.toolCalls) : null,
      providerState: message.role === 'assistant' && message.providerState ? JSON.stringify(message.providerState) : null,
      toolCallId: message.role === 'tool' ? message.toolCallId : null,
      toolName: message.role === 'tool' ? message.toolName : null,
      seq: seq + 1,
      createdAt: now,
    }
    tx.insert(chatMessages).values(row).run()
    tx.update(chatThreads).set({ updatedAt: now })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId))).run()
    return row
  })
}

export function listMessages(userId: string, threadId: string): ChatMessageRow[] {
  requireUserId(userId)
  return db.select().from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.threadId, threadId)))
    .orderBy(asc(chatMessages.seq))
    .all()
}

export function getMessage(userId: string, messageId: string): ChatMessageRow | undefined {
  requireUserId(userId)
  return db.select().from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)))
    .get()
}

export function parseToolCalls(row: Pick<ChatMessageRow, 'toolCalls'>): ModelToolCall[] {
  if (!row.toolCalls) return []
  try {
    const parsed = JSON.parse(row.toolCalls) as unknown
    return Array.isArray(parsed) ? parsed as ModelToolCall[] : []
  } catch {
    return []
  }
}

// ─── Pending actions ───────────────────────────────────────────────────────────

export function createPendingAction(userId: string, input: {
  threadId: string
  assistantMessageId: string
  toolCallId: string
  toolName: string
  args: JsonObject
}, now = Date.now()): PendingActionRow {
  requireUserId(userId)
  const row: PendingActionRow = {
    id: `pa_${nanoid()}`, userId, threadId: input.threadId, assistantMessageId: input.assistantMessageId,
    toolCallId: input.toolCallId, toolName: input.toolName, args: JSON.stringify(input.args),
    status: 'pending', expiresAt: now + PENDING_ACTION_TTL_MS, createdAt: now,
  }
  db.insert(agentPendingActions).values(row).run()
  return row
}

export function getPendingAction(userId: string, actionId: string): PendingActionRow | undefined {
  requireUserId(userId)
  return db.select().from(agentPendingActions)
    .where(and(eq(agentPendingActions.id, actionId), eq(agentPendingActions.userId, userId)))
    .get()
}

export function listPendingActions(userId: string, threadId: string, opts: { assistantMessageId?: string } = {}): PendingActionRow[] {
  requireUserId(userId)
  return db.select().from(agentPendingActions)
    .where(and(
      eq(agentPendingActions.userId, userId),
      eq(agentPendingActions.threadId, threadId),
      eq(agentPendingActions.status, 'pending'),
      opts.assistantMessageId ? eq(agentPendingActions.assistantMessageId, opts.assistantMessageId) : undefined,
    ))
    .orderBy(asc(agentPendingActions.createdAt))
    .all()
}

/**
 * Single-use transition out of `pending`. One conditional UPDATE, so two
 * concurrent confirms can't both win. `unexpiredAt` additionally requires
 * `expires_at > unexpiredAt` (the confirm path). Returns false when the action
 * is missing, foreign, already resolved, or (with `unexpiredAt`) expired.
 */
export function transitionPendingAction(
  userId: string,
  actionId: string,
  to: Exclude<PendingActionStatus, 'pending'>,
  opts: { unexpiredAt?: number } = {},
): boolean {
  requireUserId(userId)
  const expiryClause = opts.unexpiredAt !== undefined ? 'AND expires_at > ?' : ''
  const params: unknown[] = [to, actionId, userId]
  if (opts.unexpiredAt !== undefined) params.push(opts.unexpiredAt)
  return getSqlite().prepare(`UPDATE agent_pending_actions SET status = ?
    WHERE id = ? AND user_id = ? AND status = 'pending' ${expiryClause}`).run(...params).changes === 1
}

export interface DeclinedAction {
  action: PendingActionRow
  reason: 'user_cancelled' | 'expired' | 'superseded'
  result: JsonObject
}

/**
 * Declines one pending action and appends its `{ declined: true }` tool result
 * in the same transaction, so the history never holds a resolved action without
 * a result. Returns null if it was no longer pending.
 */
export function declinePendingAction(
  userId: string,
  action: PendingActionRow,
  reason: DeclinedAction['reason'],
  turnId: string,
): DeclinedAction | null {
  const status: PendingActionStatus = reason === 'user_cancelled' ? 'cancelled' : reason
  const result: JsonObject = { declined: true, reason }
  return db.transaction(() => {
    if (!transitionPendingAction(userId, action.id, status)) return null
    appendMessage(userId, action.threadId, {
      role: 'tool', turnId, toolCallId: action.toolCallId, toolName: action.toolName, content: result,
    })
    return { action, reason, result }
  })
}

/** Lazy expiry: resolves a thread's past-due pending actions to `expired`. */
export function expireStalePendingActions(userId: string, threadId: string, now = Date.now()): DeclinedAction[] {
  const declined: DeclinedAction[] = []
  for (const action of listPendingActions(userId, threadId)) {
    if (action.expiresAt > now) continue
    const turnId = getMessage(userId, action.assistantMessageId)?.turnId ?? action.assistantMessageId
    const done = declinePendingAction(userId, action, 'expired', turnId)
    if (done) declined.push(done)
  }
  return declined
}

// ─── Turn lease + daily allowance ──────────────────────────────────────────────

export const CHAT_FREE_TURNS_PER_DAY = 10

/**
 * Distinct turns today with at least one chat_turn model call that reached the
 * user: a success, or a failure after text streamed (aborting mid-answer must
 * not keep a turn out of the free allowance, #328 threat #3).
 */
export function countTodayChatTurns(userId: string, now = Date.now()): number {
  requireUserId(userId)
  const row = db.select({ n: sql<number>`COUNT(DISTINCT ${aiCalls.turnId})` }).from(aiCalls)
    .where(and(
      eq(aiCalls.userId, userId),
      eq(aiCalls.task, 'chat_turn'),
      or(eq(aiCalls.success, 1), like(aiCalls.errorMessage, `${PARTIAL_OUTPUT_ERROR_PREFIX}%`)),
      gte(aiCalls.createdAt, startOfUtcDayMs(now)),
    ))
    .get()
  return row?.n ?? 0
}

/**
 * Wholesale cost of everything chat spent today, across users, in
 * COST_UNITS_PER_USD units: the chat_turn calls plus the model calls its tools
 * made (suggest, discover, try-on…), which carry the turn's id.
 */
export function todayChatWholesaleCostX100(now = Date.now()): number {
  const row = db.select({ total: sql<number>`COALESCE(SUM(${aiCalls.wholesaleCostCentsX100}), 0)` }).from(aiCalls)
    .where(and(
      or(eq(aiCalls.task, 'chat_turn'), isNotNull(aiCalls.turnId)),
      gte(aiCalls.createdAt, startOfUtcDayMs(now)),
    ))
    .get()
  return row?.total ?? 0
}

export interface TurnLease {
  userId: string
  token: string
  /** Tokens this turn costs: 0 inside the daily free allowance, else 1. */
  cost: number
}

/**
 * Takes the per-user in-flight lease inside BEGIN IMMEDIATE (the
 * src/jobs/claims.ts pattern) and counts the free allowance in the same
 * transaction, so parallel requests can't all read "9 used". An expired lease
 * (crashed turn) is taken over. Throws ChatTurnInFlightError when a live
 * lease exists.
 */
export function acquireTurnLease(userId: string, opts: { chargeable: boolean }, now = Date.now()): TurnLease {
  requireUserId(userId)
  const sqlite = getSqlite()
  return sqlite.transaction(() => {
    const existing = sqlite.prepare('SELECT expires_at AS expiresAt FROM chat_turn_leases WHERE user_id = ?')
      .get(userId) as { expiresAt: number } | undefined
    if (existing && existing.expiresAt > now) throw new ChatTurnInFlightError()
    const token = nanoid()
    sqlite.prepare(`INSERT INTO chat_turn_leases (user_id, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`)
      .run(userId, token, now + TURN_LEASE_MS)
    const cost = opts.chargeable && countTodayChatTurns(userId, now) >= CHAT_FREE_TURNS_PER_DAY ? 1 : 0
    return { userId, token, cost }
  }).immediate()
}

/** Token-fenced: a turn whose lease was taken over can't release the new owner's. */
export function releaseTurnLease(lease: Pick<TurnLease, 'userId' | 'token'>): void {
  getSqlite().prepare('DELETE FROM chat_turn_leases WHERE user_id = ? AND token = ?').run(lease.userId, lease.token)
}
