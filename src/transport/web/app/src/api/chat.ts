import { apiFetch, apiFetchJSON } from './client'

// #328 — /api/chat/* client. Streams are fetch-POST + a manual SSE reader
// (the useDiscoverStream pattern), never EventSource: that is GET-only, can't
// send the CSRF header, and would put the message in the URL.

export type ChatEvent =
  | { type: 'thread'; threadId: string; title: string | null }
  | { type: 'status'; step: number; status: 'thinking' | 'step_limit' }
  | { type: 'message_delta'; text: string }
  | { type: 'tool_preview'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result?: unknown; error?: string }
  | { type: 'confirmation_required'; id: string; toolCallId: string; toolName: string; args: Record<string, unknown>; expiresAt: number; summary?: string | null }
  | { type: 'done'; finishReason: string; steps: number }
  | { type: 'error'; error: string; code: string; required?: number; balance?: number }

export interface ChatThreadSummary {
  id: string
  title: string | null
  updatedAt: number
}

export type ChatMessageView =
  | { id: string; role: 'user'; content: string; turnId: string; createdAt: number }
  | { id: string; role: 'assistant'; content: string; turnId: string; createdAt: number; toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] }
  | { id: string; role: 'tool'; content: unknown; turnId: string; createdAt: number; toolCallId: string; toolName: string }

export interface PendingActionView {
  id: string
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  expiresAt: number
  /** Confirm card text from the server, with names looked up (#338). */
  summary?: string | null
}

export interface ChatThreadDetail {
  thread: ChatThreadSummary
  messages: ChatMessageView[]
  pendingActions: PendingActionView[]
}

/** A request the server refused before streaming (400/404/409/402/429/503). */
export class ChatRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ChatRequestError'
  }
}

export function listChatThreads(before?: number): Promise<{ threads: ChatThreadSummary[]; nextBefore: number | null }> {
  const qs = before !== undefined ? `?before=${before}` : ''
  return apiFetchJSON(`/api/chat/threads${qs}`)
}

export function getChatThread(id: string): Promise<ChatThreadDetail> {
  return apiFetchJSON(`/api/chat/threads/${encodeURIComponent(id)}`)
}

export async function deleteChatThread(id: string): Promise<void> {
  const res = await apiFetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new ChatRequestError('Could not delete the chat', res.status)
}

const REFUSALS: Record<number, string> = {
  404: 'That chat no longer exists.',
  409: 'Still answering your last message.',
  429: 'Too many messages — wait a moment.',
  503: 'Ask is taking a break. Try again later.',
}

/** The browser's IANA zone, so "today" and time of day match the user (the server runs in UTC). */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** POSTs to a chat stream route and feeds each SSE event to `onEvent`. */
export async function streamChat(
  path: '/api/chat/stream' | '/api/chat/confirm' | '/api/chat/cancel',
  body: Record<string, unknown>,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const timeZone = browserTimeZone()
  const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(timeZone ? { ...body, timeZone } : body), signal })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; code?: string; required?: number; balance?: number }
    if (res.status === 402 && err.code === 'INSUFFICIENT_TOKENS') {
      window.dispatchEvent(new CustomEvent('insufficient-tokens', {
        detail: { required: err.required ?? 0, balance: err.balance ?? 0 },
      }))
    }
    throw new ChatRequestError(REFUSALS[res.status] ?? err.error ?? 'Something went wrong', res.status, err.code)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new ChatRequestError('No response body', 500)
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      // Heartbeats are SSE comments (": ping") with no data line.
      const data = part.split('\n').find(line => line.startsWith('data: '))
      if (!data) continue
      onEvent(JSON.parse(data.slice(6)) as ChatEvent)
    }
  }
}

export type ChatAllowance =
  | { billing: false }
  | { billing: true; tokensPerMessage: number; freePerDay: number; freeLeft: number }

/** #339 — the composer hint. Self-host reports `billing: false`. */
export async function fetchChatAllowance(): Promise<ChatAllowance> {
  return apiFetchJSON<ChatAllowance>('/api/chat/allowance')
}
