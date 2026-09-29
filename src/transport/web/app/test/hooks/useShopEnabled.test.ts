import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useShopEnabled, resetShopEnabled } from '../../src/hooks/useShopEnabled'

function mockStatus(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve(body) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useShopEnabled', () => {
  beforeEach(() => resetShopEnabled())
  afterEach(() => vi.unstubAllGlobals())

  it('starts false and turns true when /api/auth/status reports shopEnabled', async () => {
    mockStatus({ shopEnabled: true })
    const { result } = renderHook(() => useShopEnabled())
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('stays false when the server reports it off or omits the field', async () => {
    const fetchMock = mockStatus({ google: true })
    const { result } = renderHook(() => useShopEnabled())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/status'))
    await Promise.resolve()
    expect(result.current).toBe(false)
  })

  it('stays false when the status request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { result } = renderHook(() => useShopEnabled())
    await Promise.resolve()
    expect(result.current).toBe(false)
  })

  it('fetches once and serves later mounts from the cache', async () => {
    const fetchMock = mockStatus({ shopEnabled: true })
    const first = renderHook(() => useShopEnabled())
    await waitFor(() => expect(first.result.current).toBe(true))
    const second = renderHook(() => useShopEnabled())
    expect(second.result.current).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
