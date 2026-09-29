// 429 handling for the Add Item bulk passes. bulk-detect and /analyze share
// one per-user budget on the server (perUserRateLimit, 30/min), so a large
// batch is expected to hit it. A 429 is pacing, not failure: the job waits out
// Retry-After and runs again, and every other job on the same gate waits with
// it so the queue doesn't burn uploads on requests the server will refuse.

import { apiFetch, InsufficientTokensError } from '../api/client'

const DEFAULT_RETRY_AFTER_MS = 10_000
const MIN_RETRY_AFTER_MS = 1_000
// The server window is 60s; anything longer is a bad header, not a real wait.
const MAX_RETRY_AFTER_MS = 60_000
// Spreads the jobs that wake together at the window reset.
const RETRY_JITTER_MS = 500
// 429s are expected, so allow several windows before giving the job up and
// letting the user retry it by hand.
export const MAX_RATE_LIMIT_ATTEMPTS = 6

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const
  constructor(readonly retryAfterMs: number = DEFAULT_RETRY_AFTER_MS) {
    super('rate_limited')
    this.name = 'RateLimitedError'
  }
}

/** Retry-After (delta-seconds or HTTP-date), else the body's retryAfterSeconds, clamped. */
export function parseRetryAfterMs(header: string | null, bodySeconds?: unknown, now = Date.now()): number {
  let ms: number | null = null
  if (header) {
    const secs = Number(header)
    if (Number.isFinite(secs)) ms = secs * 1000
    else {
      const date = Date.parse(header)
      if (Number.isFinite(date)) ms = date - now
    }
  }
  if (ms === null && typeof bodySeconds === 'number' && Number.isFinite(bodySeconds)) ms = bodySeconds * 1000
  if (ms === null) ms = DEFAULT_RETRY_AFTER_MS
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms))
}

export function isRateLimited(err: unknown): err is RateLimitedError {
  return err instanceof RateLimitedError
}

async function readJsonSafe<T>(res: Response): Promise<T | null> {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) as T } catch { return null }
}

/**
 * apiFetchJSON, except a 429 throws RateLimitedError carrying the server's
 * Retry-After. Other failures behave as apiFetchJSON (402 → InsufficientTokensError).
 */
export async function apiFetchJSONRateAware<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  if (res.status === 429) {
    const body = await readJsonSafe<{ retryAfterSeconds?: number }>(res)
    throw new RateLimitedError(parseRetryAfterMs(res.headers.get('Retry-After'), body?.retryAfterSeconds))
  }
  if (!res.ok) {
    const body = await readJsonSafe<{ code?: string; required?: number; balance?: number; error?: string }>(res)
    if (res.status === 402 && body?.code === 'INSUFFICIENT_TOKENS') {
      window.dispatchEvent(new CustomEvent('insufficient-tokens', {
        detail: { required: body.required ?? 0, balance: body.balance ?? 0 },
      }))
      throw new InsufficientTokensError(body.required ?? 0, body.balance ?? 0)
    }
    throw new Error(body?.error ?? res.statusText)
  }
  const body = await readJsonSafe<T>(res)
  if (body === null) throw new Error(`Empty response from ${path}`)
  return body
}

/**
 * Shared pause for every job that draws on the same server budget. `pause`
 * pushes the resume time out (never earlier); `wait` resolves once it passes.
 */
export interface RateLimitGate {
  wait(): Promise<void>
  pause(ms: number): void
  readonly paused: boolean
  dispose(): void
}

export function createRateLimitGate(onPacingChange?: (pacing: boolean) => void): RateLimitGate {
  let until = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: Array<() => void> = []

  const resume = () => {
    timer = null
    until = 0
    const ready = waiters
    waiters = []
    onPacingChange?.(false)
    for (const w of ready) w()
  }

  return {
    get paused() { return until > Date.now() },
    wait() {
      if (until <= Date.now()) return Promise.resolve()
      return new Promise<void>(resolve => { waiters.push(resolve) })
    },
    pause(ms: number) {
      const next = Date.now() + ms
      if (next <= until) return
      const wasPaused = timer !== null
      until = next
      if (timer) clearTimeout(timer)
      timer = setTimeout(resume, ms)
      if (!wasPaused) onPacingChange?.(true)
    },
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      // Release anything still parked so it can observe its own cancellation.
      const ready = waiters
      waiters = []
      for (const w of ready) w()
    },
  }
}

/**
 * Runs `task`, and on a 429 pauses the gate for Retry-After (+ jitter) and
 * runs the same task again. Any other error, or running out of attempts,
 * rejects so the caller can mark just this job failed.
 */
export async function withRateLimitRetry<T>(
  task: () => Promise<T>,
  opts: { gate: RateLimitGate; maxAttempts?: number; jitterMs?: number },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_RATE_LIMIT_ATTEMPTS
  const jitter = opts.jitterMs ?? RETRY_JITTER_MS
  for (let attempt = 1; ; attempt++) {
    await opts.gate.wait()
    try {
      return await task()
    } catch (err) {
      if (!isRateLimited(err) || attempt >= maxAttempts) throw err
      opts.gate.pause(err.retryAfterMs + Math.floor(Math.random() * jitter))
    }
  }
}
