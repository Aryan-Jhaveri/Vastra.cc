import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/api/jobs', () => ({
  fetchUpcomingJobs: vi.fn(),
  fetchJobHistory: vi.fn(),
}))

import { useReminders } from '../../src/hooks/useReminders'
import * as jobsApi from '../../src/api/jobs'

type Listener = (e: MessageEvent) => void
const swListeners: Record<string, Listener[]> = {}
const swMock = {
  addEventListener: (type: string, cb: Listener) => { (swListeners[type] ??= []).push(cb) },
  removeEventListener: (type: string, cb: Listener) => {
    swListeners[type] = (swListeners[type] ?? []).filter(f => f !== cb)
  },
}

function emitSwMessage(data: unknown) {
  for (const cb of [...(swListeners['message'] ?? [])]) cb({ data } as MessageEvent)
}
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const k of Object.keys(swListeners)) delete swListeners[k]
  Object.defineProperty(navigator, 'serviceWorker', { value: swMock, configurable: true })
  vi.mocked(jobsApi.fetchUpcomingJobs).mockResolvedValue([])
  vi.mocked(jobsApi.fetchJobHistory).mockResolvedValue([])
  setVisibility('visible')
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useReminders — auto-refresh', () => {
  it('refetches immediately when the tab becomes visible', async () => {
    setVisibility('hidden')
    renderHook(() => useReminders())
    await flush()
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    setVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()

    expect(jobsApi.fetchJobHistory).toHaveBeenCalled()
  })

  it('polls every 30s while visible', async () => {
    renderHook(() => useReminders())
    await flush()
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    await act(async () => { vi.advanceTimersByTime(30_000) })
    await flush()

    expect(jobsApi.fetchJobHistory).toHaveBeenCalledTimes(1)
  })

  it('does not poll while hidden', async () => {
    renderHook(() => useReminders())
    await flush()

    setVisibility('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    await act(async () => { vi.advanceTimersByTime(120_000) })
    await flush()

    expect(jobsApi.fetchJobHistory).not.toHaveBeenCalled()
  })

  it('refetches on a serviceWorker JOB_FIRED message', async () => {
    renderHook(() => useReminders())
    await flush()
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    await act(async () => { emitSwMessage({ type: 'JOB_FIRED' }) })
    await flush()

    expect(jobsApi.fetchJobHistory).toHaveBeenCalled()
  })

  it('ignores unrelated serviceWorker messages', async () => {
    renderHook(() => useReminders())
    await flush()
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    await act(async () => { emitSwMessage({ type: 'SOMETHING_ELSE' }) })
    await flush()

    expect(jobsApi.fetchJobHistory).not.toHaveBeenCalled()
  })

  it('tears down the interval and listeners on unmount', async () => {
    const { unmount } = renderHook(() => useReminders())
    await flush()

    unmount()
    vi.mocked(jobsApi.fetchJobHistory).mockClear()

    await act(async () => { vi.advanceTimersByTime(120_000) })
    emitSwMessage({ type: 'JOB_FIRED' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(jobsApi.fetchJobHistory).not.toHaveBeenCalled()
    expect(swListeners['message']?.length ?? 0).toBe(0)
  })
})
