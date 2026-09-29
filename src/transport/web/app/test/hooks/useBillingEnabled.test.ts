import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useBillingEnabled, resetBillingEnabled } from '../../src/hooks/useBillingEnabled'

function mockStatus(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useBillingEnabled', () => {
  beforeEach(() => resetBillingEnabled())
  afterEach(() => vi.unstubAllGlobals())

  it('starts false and turns true when /api/auth/status reports billing', async () => {
    mockStatus({ billing: true })
    const { result } = renderHook(() => useBillingEnabled())
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('stays false when the server reports it off or omits the field', async () => {
    const fetchMock = mockStatus({ google: true })
    const { result } = renderHook(() => useBillingEnabled())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/status'))
    await Promise.resolve()
    expect(result.current).toBe(false)
  })

  it('stays false when the status request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { result } = renderHook(() => useBillingEnabled())
    await Promise.resolve()
    expect(result.current).toBe(false)
  })
})
