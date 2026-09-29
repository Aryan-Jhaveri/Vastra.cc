import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RateLimitedError, parseRetryAfterMs, createRateLimitGate, withRateLimitRetry, apiFetchJSONRateAware,
} from '../../src/lib/rateLimitRetry'

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds, HTTP-date, then the body, then a default', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000)
    const now = Date.parse('2026-09-27T12:00:00Z')
    expect(parseRetryAfterMs('Sun, 27 Sep 2026 12:00:20 GMT', undefined, now)).toBe(20_000)
    expect(parseRetryAfterMs(null, 7)).toBe(7_000)
    expect(parseRetryAfterMs(null)).toBe(10_000)
  })

  it('clamps to 1s–60s', () => {
    expect(parseRetryAfterMs('0')).toBe(1_000)
    expect(parseRetryAfterMs('3600')).toBe(60_000)
  })
})

describe('withRateLimitRetry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('waits out Retry-After and runs the same task again', async () => {
    const gate = createRateLimitGate()
    const task = vi.fn()
      .mockRejectedValueOnce(new RateLimitedError(5_000))
      .mockResolvedValueOnce('ok')
    const run = withRateLimitRetry(task, { gate, jitterMs: 0 })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(run).resolves.toBe('ok')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('does not retry other errors', async () => {
    const gate = createRateLimitGate()
    const task = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(withRateLimitRetry(task, { gate })).rejects.toThrow('boom')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxAttempts 429s', async () => {
    const gate = createRateLimitGate()
    const task = vi.fn().mockRejectedValue(new RateLimitedError(1_000))
    const run = withRateLimitRetry(task, { gate, maxAttempts: 3, jitterMs: 0 })
    const settled = expect(run).rejects.toBeInstanceOf(RateLimitedError)
    await vi.advanceTimersByTimeAsync(5_000)
    await settled
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('a 429 on one job holds every other job on the gate, and reports pacing', async () => {
    const pacing: boolean[] = []
    const gate = createRateLimitGate(p => pacing.push(p))
    const first = withRateLimitRetry(
      vi.fn().mockRejectedValueOnce(new RateLimitedError(2_000)).mockResolvedValue(1),
      { gate, jitterMs: 0 },
    )
    await vi.advanceTimersByTimeAsync(0)
    const other = vi.fn().mockResolvedValue(2)
    const second = withRateLimitRetry(other, { gate, jitterMs: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(other).not.toHaveBeenCalled()
    expect(gate.paused).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(pacing).toEqual([true, false])
  })
})

describe('apiFetchJSONRateAware', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('turns a 429 into RateLimitedError carrying Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 40 }),
      { status: 429, headers: { 'Retry-After': '17' } },
    )))
    const err = await apiFetchJSONRateAware('/api/items/analyze', { method: 'POST' }).catch(e => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err.retryAfterMs).toBe(17_000)
  })

  it('falls back to the body when the header is missing, and passes other errors through', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ retryAfterSeconds: 9 }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    const err = await apiFetchJSONRateAware('/x').catch(e => e)
    expect(err.retryAfterMs).toBe(9_000)
    await expect(apiFetchJSONRateAware('/x')).rejects.toThrow('nope')
    await expect(apiFetchJSONRateAware('/x')).resolves.toEqual({ ok: true })
  })
})
