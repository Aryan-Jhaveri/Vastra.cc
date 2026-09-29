import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/api/client', () => ({
  apiFetch: vi.fn(),
  apiFetchJSON: vi.fn(),
}))

import { usePushNotifications } from '../../src/hooks/usePushNotifications'
import * as client from '../../src/api/client'

type TestResult = { ok: boolean; sent: number; error?: string }

describe('usePushNotifications.sendTest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POSTs to /api/push/test and returns ok + sent count on success', async () => {
    vi.mocked(client.apiFetchJSON).mockResolvedValue({ sent: 2 })

    const { result } = renderHook(() => usePushNotifications())

    let out: TestResult | undefined
    await act(async () => {
      out = await result.current.sendTest()
    })

    expect(client.apiFetchJSON).toHaveBeenCalledWith('/api/push/test', { method: 'POST' })
    expect(out).toEqual({ ok: true, sent: 2 })
  })

  it('returns ok=false with the error message on failure', async () => {
    vi.mocked(client.apiFetchJSON).mockRejectedValue(new Error('Push not configured'))

    const { result } = renderHook(() => usePushNotifications())

    let out: TestResult | undefined
    await act(async () => {
      out = await result.current.sendTest()
    })

    expect(out?.ok).toBe(false)
    expect(out?.sent).toBe(0)
    expect(out?.error).toBe('Push not configured')
  })
})
