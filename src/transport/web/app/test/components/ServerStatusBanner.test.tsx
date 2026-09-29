import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { ServerStatusBanner } from '../../src/components/ServerStatusBanner'

describe('ServerStatusBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is hidden initially', () => {
    render(<ServerStatusBanner />)
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()
  })

  it('shows after verify ping fails with non-2xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/status', { cache: 'no-store' })
    expect(screen.getByText('App is updating')).toBeInTheDocument()
  })

  it('suppresses when verify ping returns 2xx', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/status', { cache: 'no-store' })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()
  })

  it('shows when verify ping throws', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/status', { cache: 'no-store' })
    expect(screen.getByText('App is updating')).toBeInTheDocument()
  })

  it('subsequent events while dismissed do not re-show the banner', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockRejectedValueOnce(new Error('Network error'))
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.getByText('App is updating')).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByText('Dismiss'))
    })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()
  })

  it('successful poll clears dismiss so the next failure can re-show', async () => {
    vi.useRealTimers()
    vi.useFakeTimers()

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.getByText('App is updating')).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByText('Dismiss'))
    })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(5000)
      await Promise.resolve()
    })

    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 })
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.getByText('App is updating')).toBeInTheDocument()

    vi.unstubAllGlobals()
  })

  it('concurrent events fire only one verify ping', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByText('App is updating')).toBeInTheDocument()
  })

  it('clicking Dismiss hides banner but keeps polling', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.getByText('App is updating')).toBeInTheDocument()

    act(() => {
      fireEvent.click(screen.getByText('Dismiss'))
    })
    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('clicking Reload unregisters SW and reloads', async () => {
    const unregister = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([{ unregister }]),
      },
    })
    const reloadMock = vi.fn()
    vi.stubGlobal('location', { reload: reloadMock })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Reload'))
    })

    expect(unregister).toHaveBeenCalled()
    expect(reloadMock).toHaveBeenCalled()
  })

  it('auto-hides after successful poll', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', mockFetch)

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })
    expect(screen.getByText('App is updating')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    await act(async () => {
      vi.advanceTimersByTime(100)
    })

    expect(screen.queryByText('App is updating')).not.toBeInTheDocument()
  })

  it('handles browsers without serviceWorker support', async () => {
    vi.stubGlobal('navigator', {})
    const reloadMock = vi.fn()
    vi.stubGlobal('location', { reload: reloadMock })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    render(<ServerStatusBanner />)
    
    await act(async () => {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 503 } }))
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Reload'))
    })

    expect(reloadMock).toHaveBeenCalled()
  })
})
