import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockApiFetch = vi.fn().mockResolvedValue(undefined)

vi.mock('../../src/api/client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}))

const mockSendBeacon = vi.fn().mockReturnValue(true)
const mockFetch = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  // Fresh module state per test: vitest ≥3 reinstalls (and clears) the fake
  // timer set on every vi.useFakeTimers() call, so a timer scheduled by an
  // earlier test no longer survives into this one. The module-scoped
  // flushTimer would stay stale-truthy and scheduleFlush() would never arm.
  vi.resetModules()
  vi.useFakeTimers()
  // The visibility/unload flush path uses a bare keepalive fetch (NOT
  // apiFetch, NOT sendBeacon) so it can carry the CSRF header (#295 review
  // item 3). Stub global fetch for it; sendBeacon stays stubbed so tests
  // can assert it is never used.
  vi.stubGlobal('fetch', mockFetch)
  ;(window.navigator as any).sendBeacon = mockSendBeacon
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function waitForFlush() {
  await vi.runAllTimersAsync()
}

async function importAnalytics() {
  const mod = await import('../../src/lib/analytics')
  // re-initialize for each test
  return mod
}

describe('analytics client', () => {
  it('track() queues events without fetching immediately', async () => {
    const { track } = await importAnalytics()
    track('page_view', { from: '/home' })
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('5s timer triggers flush via timer', async () => {
    const { track } = await importAnalytics()
    track('page_view')
    expect(mockApiFetch).not.toHaveBeenCalled()

    await waitForFlush()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    const url = mockApiFetch.mock.calls[0][0]
    expect(url).toBe('/api/events')
  })

  it('session ID is stored after first event', async () => {
    const { track } = await importAnalytics()
    track('pwa_launched')
    // sessionStorage is populated on first call to track()
    const stored = sessionStorage.getItem('closet:analytics:session') || 'none'
    expect(stored.length).toBeGreaterThan(0)
    expect(stored).not.toBe('none')
  })

  it('initAnalytics wires visibilitychange to a keepalive fetch with the CSRF header', async () => {
    const { track, initAnalytics } = await importAnalytics()
    initAnalytics()
    track('page_view')
    // Simulate page hiding
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(100)

    // sendBeacon cannot set headers, so the server's CSRF middleware would
    // reject it — the unload path must use a keepalive fetch instead (#295).
    expect(mockSendBeacon).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [path, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/events')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(init.credentials).toBe('same-origin')
    const headers = new Headers(init.headers)
    expect(headers.get('X-Requested-With')).toBe('vastra')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('unload (pagehide) flush also sends the CSRF header via keepalive fetch', async () => {
    const { track, flush } = await importAnalytics()
    track('page_view')
    await flush('unload')

    expect(mockSendBeacon).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('X-Requested-With')).toBe('vastra')
    expect(init.keepalive).toBe(true)
  })

  it('flush clears queue', async () => {
    const { track, flush } = await importAnalytics()
    track('page_view')
    await flush('timer')
    expect(mockApiFetch).toHaveBeenCalledTimes(1)

    await flush('timer')
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
  })

  it('initAnalytics registers listeners once', async () => {
    const { initAnalytics } = await importAnalytics()
    const addSpy = vi.spyOn(document, 'addEventListener')
    initAnalytics()
    const calls1 = addSpy.mock.calls.length
    initAnalytics()
    // Second init should be a no-op
    expect(addSpy).toHaveBeenCalledTimes(calls1)
  })
})
