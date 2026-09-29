import { nanoid } from 'nanoid'
import { apiFetch } from '../api/client'

export type EventType =
  | 'item_added'
  | 'item_edited'
  | 'item_deleted'
  | 'item_opened'
  | 'item_tag_scanned'
  | 'suggest_requested'
  | 'suggest_viewed'
  | 'suggest_saved'
  | 'suggest_dismissed'
  | 'discover_opened'
  | 'discover_result_saved'
  | 'share_opened'
  | 'tryon_started'
  | 'tryon_completed'
  | 'tryon_saved'
  | 'tryon_discarded'
  | 'page_view'
  | 'filter_applied'
  | 'pwa_installed'
  | 'pwa_launched'

interface QueuedEvent {
  id: string
  sessionId: string
  eventType: EventType
  route?: string
  properties?: Record<string, unknown>
  pwaMode: number
  durationMs?: number
  createdAt: number
}

let queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let sessionId = ''

const FLUSH_INTERVAL = 5000
const MAX_QUEUE = 50

function getSessionId(): string {
  if (!sessionId && typeof window !== 'undefined') {
    try {
      sessionId = sessionStorage.getItem('closet:analytics:session') ?? ''
      if (!sessionId) {
        sessionId = nanoid()
        sessionStorage.setItem('closet:analytics:session', sessionId)
      }
    } catch {
      sessionId = nanoid()
    }
  }
  return sessionId
}

function getPwaMode(): number {
  if (typeof window === 'undefined') return 0
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return 1
    if ((navigator as any).standalone) return 1
  } catch { /* ignore */ }
  return 0
}

function getRoute(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.location.pathname
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush('timer')
  }, FLUSH_INTERVAL)
}

async function sendBatch(events: QueuedEvent[], reason: string): Promise<void> {
  try {
    await apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({ events }),
      headers: { 'Content-Type': 'application/json' },
    }, { silent: true })
  } catch (err) {
    if (reason !== 'unload' && reason !== 'visibility') {
      console.warn('[analytics] flush failed, requeuing:', (err as Error).message)
      queue.push(...events)
      scheduleFlush()
    }
  }
}

export function track(eventType: EventType, properties?: Record<string, unknown>, opts?: { durationMs?: number }): void {
  const event: QueuedEvent = {
    id: nanoid(),
    sessionId: getSessionId(),
    eventType,
    route: getRoute(),
    properties,
    pwaMode: getPwaMode(),
    durationMs: opts?.durationMs,
    createdAt: Date.now(),
  }
  queue.push(event)

  if (queue.length >= MAX_QUEUE) {
    void flush('size')
  } else {
    scheduleFlush()
  }
}

export async function flush(reason: 'timer' | 'size' | 'visibility' | 'unload'): Promise<void> {
  if (queue.length === 0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const batch = queue.splice(0)
  const payload = JSON.stringify({ events: batch })

  if (reason === 'visibility' || reason === 'unload') {
    // No sendBeacon: it cannot set headers, so the request would fail the
    // server's CSRF middleware. A keepalive fetch carries the proof header
    // and still survives page unload (#295 review item 3).
    try {
      await fetch('/api/events', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'vastra',
        },
        body: payload,
        keepalive: true,
      })
    } catch { /* best effort */ }
  } else {
    await sendBatch(batch, reason)
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    void flush('visibility')
  }
}

function handlePageHide(): void {
  void flush('unload')
}

let initialized = false

export function initAnalytics(): void {
  if (initialized) return
  initialized = true

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', handlePageHide)
  }
}
