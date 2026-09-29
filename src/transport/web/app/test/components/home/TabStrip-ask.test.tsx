import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, renderHook, waitFor } from '@testing-library/react'
import { TabStrip } from '../../../src/components/home/TabStrip'
import { useChatEnabled, resetChatEnabled } from '../../../src/hooks/useChatEnabled'

describe('Ask tab gating (#328)', () => {
  beforeEach(() => resetChatEnabled())
  afterEach(() => vi.unstubAllGlobals())

  it('renders the Ask tab only when showAsk is true', () => {
    const { rerender } = render(<TabStrip active="suggest" onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Ask' })).toBeNull()
    rerender(<TabStrip active="suggest" onChange={() => {}} showAsk />)
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
  })

  it('useChatEnabled follows /api/auth/status chatEnabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ chatEnabled: true }) }))
    const { result } = renderHook(() => useChatEnabled())
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('useChatEnabled stays false when the flag is missing or the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { result } = renderHook(() => useChatEnabled())
    await new Promise(r => setTimeout(r, 10))
    expect(result.current).toBe(false)
  })
})
