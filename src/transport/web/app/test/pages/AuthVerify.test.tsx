import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { AuthVerify } from '../../src/pages/AuthVerify'

const mockFetch = vi.fn()

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('AuthVerify — cookie-only magic-link confirm (#295)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('fetch', mockFetch)
    // runConfirm calls window.close() on success — in jsdom that tears down
    // the whole environment, so it is stubbed out.
    vi.spyOn(window, 'close').mockImplementation(() => {})
    window.history.replaceState({}, '', '/auth/verify?token=tok-abc')
  })

  it('valid link auto-confirms: pings other tabs, never stores a token', async () => {
    mockFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/auth/verify-preview')) {
        return Promise.resolve(jsonRes({ valid: true, expired: false, email: 'a@b.com' }))
      }
      if (path === '/api/auth/verify-confirm') {
        return Promise.resolve(jsonRes({ ok: true, user: { id: 'u1', email: 'a@b.com', name: null } }))
      }
      return Promise.resolve(jsonRes({}))
    })

    const sessionPing = vi.fn()
    window.addEventListener('vastra:session', sessionPing)

    render(<AuthVerify />)

    // Skip the countdown — the manual authorize button fires the same path.
    const authorize = await screen.findByRole('button', { name: /Authorize now/i })
    fireEvent.click(authorize)

    await vi.waitFor(() => {
      expect(localStorage.getItem('closet-session-changed')).toBeTruthy()
    })

    // The confirm POST asks for a persistent cookie and carries no secret back.
    const confirmCall = mockFetch.mock.calls.find(c => c[0] === '/api/auth/verify-confirm')!
    expect(JSON.parse(confirmCall[1].body)).toEqual({ token: 'tok-abc', remember: true })

    // Session handoff is cookie-only: no token key in ANY web storage.
    expect(localStorage.getItem('closet-auth-token')).toBeNull()
    expect(sessionStorage.getItem('closet-auth-token')).toBeNull()

    window.removeEventListener('vastra:session', sessionPing)
    expect(sessionPing).toHaveBeenCalled()
  })

  it('failed confirm shows the failure UI and broadcasts nothing', async () => {
    // Own token: confirmTokenOnce caches by token at module scope, and the
    // first test already confirmed 'tok-abc'.
    window.history.replaceState({}, '', '/auth/verify?token=tok-bad')
    mockFetch.mockImplementation((path: string) => {
      if (path.startsWith('/api/auth/verify-preview')) {
        return Promise.resolve(jsonRes({ valid: true, expired: false, email: 'a@b.com' }))
      }
      if (path === '/api/auth/verify-confirm') {
        return Promise.resolve(jsonRes({ error: 'Link expired' }, 400))
      }
      return Promise.resolve(jsonRes({}))
    })

    render(<AuthVerify />)

    const authorize = await screen.findByRole('button', { name: /Authorize now/i })
    fireEvent.click(authorize)

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify-confirm', expect.objectContaining({
        method: 'POST',
      }))
    })

    await vi.waitFor(() => {
      // Failure UI replaces the authorizing card.
      expect(screen.getByText('Sign-in failed')).toBeInTheDocument()
    })
    expect(localStorage.getItem('closet-session-changed')).toBeNull()
    expect(screen.queryByText(/signed in/i)).toBeNull()
  })
})