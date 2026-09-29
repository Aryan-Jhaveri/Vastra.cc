import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChatRequestError,
  getChatThread,
  streamChat,
  type ChatEvent,
  type ChatThreadDetail,
} from '../api/chat'

// #328 — Ask tab state. The server owns history; this hook keeps a
// presentation transcript built from stream events (live) or from
// GET /api/chat/threads/:id (reload). Only the thread id is persisted.

export type ToolEntry = {
  kind: 'tool'; key: string; callId: string; name: string; args: Record<string, unknown>
  status: 'running' | 'done' | 'error'; result?: unknown; error?: string
}
export type ConfirmEntry = {
  kind: 'confirm'; key: string; actionId: string | null; callId: string; toolName: string; args: Record<string, unknown>
  summary?: string | null
  status: 'pending' | 'working' | 'confirmed' | 'cancelled' | 'expired' | 'failed'; result?: unknown; error?: string
}
export type ChatEntry =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | ToolEntry
  | ConfirmEntry
  | { kind: 'notice'; key: string; text: string }

/** Tools that change the closet; the server always gates them on a tap. */
const WRITE_TOOLS = new Set([
  'create_outfit', 'update_outfit', 'create_collection', 'add_outfits_to_collection',
  'remove_outfits_from_collection', 'update_collection',
])
export const CHAT_THREAD_KEY = 'closet-chat-thread'

let keySeq = 0
const nextKey = () => `e${++keySeq}`

function declinedStatus(result: unknown): ConfirmEntry['status'] | null {
  if (!result || typeof result !== 'object' || !('declined' in result)) return null
  return (result as { reason?: string }).reason === 'expired' ? 'expired' : 'cancelled'
}

/** Applies one stream event to the transcript. Pure, so it's easy to test. */
export function applyChatEvent(entries: ChatEntry[], event: ChatEvent): ChatEntry[] {
  switch (event.type) {
    case 'message_delta': {
      const last = entries.at(-1)
      if (last?.kind === 'assistant') return [...entries.slice(0, -1), { ...last, text: last.text + event.text }]
      return [...entries, { kind: 'assistant', key: nextKey(), text: event.text }]
    }
    case 'tool_preview':
      return [...entries, { kind: 'tool', key: nextKey(), callId: event.id, name: event.name, args: event.args, status: 'running' }]
    case 'confirmation_required': {
      const entry: ConfirmEntry = {
        kind: 'confirm', key: nextKey(), actionId: event.id, callId: event.toolCallId,
        toolName: event.toolName, args: event.args, summary: event.summary ?? null, status: 'pending',
      }
      const i = entries.findIndex(e => (e.kind === 'tool' || e.kind === 'confirm') && e.callId === event.toolCallId)
      if (i === -1) return [...entries, entry]
      return entries.map((e, j) => (j === i ? { ...entry, key: e.key } : e))
    }
    case 'tool_result':
      return entries.map(e => {
        if (e.kind === 'tool' && e.callId === event.id) {
          return event.error !== undefined
            ? { ...e, status: 'error' as const, error: event.error }
            : { ...e, status: 'done' as const, result: event.result }
        }
        if (e.kind === 'confirm' && e.callId === event.id) {
          if (event.error !== undefined) return { ...e, status: 'failed' as const, error: event.error }
          return { ...e, status: declinedStatus(event.result) ?? 'confirmed', result: event.result }
        }
        return e
      })
    case 'status':
      return event.status === 'step_limit'
        ? [...entries, { kind: 'notice', key: nextKey(), text: 'Stopped after too many steps. Ask a narrower question.' }]
        : entries
    case 'error':
      return [...entries, { kind: 'notice', key: nextKey(), text: event.error }]
    default:
      return entries
  }
}

/** Rebuilds the transcript from a stored thread (reload / open from list). */
export function entriesFromThread(detail: ChatThreadDetail): ChatEntry[] {
  let entries: ChatEntry[] = []
  for (const m of detail.messages) {
    if (m.role === 'user') entries.push({ kind: 'user', key: m.id, text: m.content })
    else if (m.role === 'assistant') {
      if (m.content) entries.push({ kind: 'assistant', key: m.id, text: m.content })
      for (const call of m.toolCalls) {
        entries.push(WRITE_TOOLS.has(call.name)
          ? { kind: 'confirm', key: `${m.id}:${call.id}`, actionId: null, callId: call.id, toolName: call.name, args: call.arguments, status: 'expired' }
          : { kind: 'tool', key: `${m.id}:${call.id}`, callId: call.id, name: call.name, args: call.arguments, status: 'running' })
      }
    } else {
      const content = m.content as { error?: string } | null
      entries = applyChatEvent(entries, content && typeof content === 'object' && 'error' in content && typeof content.error === 'string'
        ? { type: 'tool_result', id: m.toolCallId, name: m.toolName, error: content.error }
        : { type: 'tool_result', id: m.toolCallId, name: m.toolName, result: m.content })
    }
  }
  for (const pa of detail.pendingActions) {
    entries = applyChatEvent(entries, { type: 'confirmation_required', id: pa.id, toolCallId: pa.toolCallId, toolName: pa.toolName, args: pa.args, expiresAt: pa.expiresAt, summary: pa.summary })
  }
  // A call whose result never landed (interrupted turn) shouldn't spin forever.
  return entries.map(e => (e.kind === 'tool' && e.status === 'running' ? { ...e, status: 'done' as const } : e))
}

function readStoredThread(): string | null {
  try { return sessionStorage.getItem(CHAT_THREAD_KEY) } catch { return null }
}

function storeThread(id: string | null) {
  try {
    if (id) sessionStorage.setItem(CHAT_THREAD_KEY, id)
    else sessionStorage.removeItem(CHAT_THREAD_KEY)
  } catch { /* storage unavailable */ }
}

export function useChat() {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const threadRef = useRef<string | null>(null)

  const setThread = useCallback((id: string | null, nextTitle: string | null = null) => {
    threadRef.current = id
    setThreadId(id)
    setTitle(nextTitle)
    storeThread(id)
  }, [])

  const onEvent = useCallback((event: ChatEvent) => {
    if (event.type === 'thread') { setThread(event.threadId, event.title); return }
    if (event.type === 'error' && event.code === 'INSUFFICIENT_TOKENS') {
      window.dispatchEvent(new CustomEvent('insufficient-tokens', {
        detail: { required: event.required ?? 1, balance: event.balance ?? 0 },
      }))
    }
    setEntries(prev => applyChatEvent(prev, event))
  }, [setThread])

  const run = useCallback(async (path: Parameters<typeof streamChat>[0], body: Record<string, unknown>) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    try {
      await streamChat(path, body, onEvent, controller.signal)
      return true
    } catch (err) {
      if (controller.signal.aborted) return false
      const text = err instanceof ChatRequestError || err instanceof Error ? err.message : 'Something went wrong'
      setEntries(prev => [...prev, { kind: 'notice', key: nextKey(), text }])
      return false
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBusy(false)
    }
  }, [onEvent])

  const send = useCallback(async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    setEntries(prev => [...prev, { kind: 'user', key: nextKey(), text: message }])
    await run('/api/chat/stream', threadRef.current ? { threadId: threadRef.current, message } : { message })
  }, [busy, run])

  const resolveAction = useCallback(async (actionId: string, kind: 'confirm' | 'cancel') => {
    setEntries(prev => prev.map(e => (e.kind === 'confirm' && e.actionId === actionId ? { ...e, status: 'working' as const } : e)))
    const ok = await run(kind === 'confirm' ? '/api/chat/confirm' : '/api/chat/cancel', { actionId })
    // Refused before streaming (e.g. already resolved): don't leave it spinning.
    if (!ok) setEntries(prev => prev.map(e => (e.kind === 'confirm' && e.actionId === actionId && e.status === 'working' ? { ...e, status: 'expired' as const } : e)))
  }, [run])

  const openThread = useCallback(async (id: string) => {
    abortRef.current?.abort()
    setLoading(true)
    try {
      const detail = await getChatThread(id)
      setThread(detail.thread.id, detail.thread.title)
      setEntries(entriesFromThread(detail))
    } catch {
      setThread(null)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [setThread])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    setThread(null)
    setEntries([])
  }, [setThread])

  const stop = useCallback(() => { abortRef.current?.abort() }, [])

  // Reload restores the last open thread from the server.
  useEffect(() => {
    const stored = readStoredThread()
    if (stored) void openThread(stored)
    return () => abortRef.current?.abort()
  }, [openThread])

  return {
    entries, threadId, title, busy, loading,
    send, openThread, newChat, stop,
    confirm: (actionId: string) => resolveAction(actionId, 'confirm'),
    cancel: (actionId: string) => resolveAction(actionId, 'cancel'),
  }
}
