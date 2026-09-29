import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDelayedLoading } from '../../src/hooks/useDelayedLoading'

describe('useDelayedLoading', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not show when loading completes before showAfter', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 180, 400),
      { initialProps: { loading: true } },
    )
    expect(result.current).toBe(false)
    act(() => { vi.advanceTimersByTime(50) })
    rerender({ loading: false })
    expect(result.current).toBe(false)
  })

  it('shows after delay and stays for minVisible', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 180, 400),
      { initialProps: { loading: true } },
    )
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe(true)
    rerender({ loading: false })
    expect(result.current).toBe(true)
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current).toBe(false)
  })

  it('hides promptly after long load since minVisible already satisfied', () => {
    const { result, rerender } = renderHook(
      ({ loading }) => useDelayedLoading(loading, 180, 400),
      { initialProps: { loading: true } },
    )

    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current).toBe(true)

    act(() => { vi.advanceTimersByTime(1800) })
    expect(result.current).toBe(true)

    rerender({ loading: false })

    act(() => { vi.advanceTimersByTime(0) })
    expect(result.current).toBe(false)
  })
})
