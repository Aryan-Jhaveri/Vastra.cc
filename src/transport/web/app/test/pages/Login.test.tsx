import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'


beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ adminFallback: true, google: false }),
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))

import { Login } from '../../src/pages/Login'

describe('Login — self-hosted (no hosted signup consent)', () => {
  it('shows no consent checkbox or legal links, enables submit with just an email, and sends no acceptedTermsAt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ adminFallback: false, google: false }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<Login onLogin={vi.fn()} />)

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Terms of Service' })).toBeNull()
    const submit = screen.getByRole('button', { name: /Email me a sign-in link/i })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@b.com' } })
    expect(submit).not.toBeDisabled()

    fireEvent.click(submit)
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/auth/send-link')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(c => c[0] === '/api/auth/send-link')!
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.com' })
  })

  it('does not render admin login form in production build even when adminFallback is true', async () => {
    vi.stubEnv('DEV', false)

    render(<Login onLogin={vi.fn()} />)

    await vi.waitFor(() => {
      expect(screen.queryByPlaceholderText('Admin password')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Admin sign-in/i })).not.toBeInTheDocument()
    })
  })

  it('renders admin login form in dev build when adminFallback is true', async () => {
    vi.stubEnv('DEV', true)

    render(<Login onLogin={vi.fn()} />)

    await vi.waitFor(() => {
      expect(screen.getByPlaceholderText('Admin password')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Admin sign-in/i })).toBeInTheDocument()
    })
  })
})

describe('Login — cross-tab cookie-only session signal (#295)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ adminFallback: true, google: false }),
      ok: true,
    }))
    window.history.replaceState({}, '', '/login')
  })

  it('a closet-session-changed storage event (Tab B verified) lands the user', async () => {
    const onLogin = vi.fn()
    render(<Login onLogin={onLogin} />)

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'closet-session-changed',
      newValue: String(Date.now()),
    }))

    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled())
  })

  it('the same-tab vastra:session event lands the user too', async () => {
    const onLogin = vi.fn()
    render(<Login onLogin={onLogin} />)

    window.dispatchEvent(new CustomEvent('vastra:session'))

    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled())
  })

  it('legacy closet-auth-token storage events are ignored (no token exists)', () => {
    const onLogin = vi.fn()
    render(<Login onLogin={onLogin} />)

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'closet-auth-token',
      newValue: 'someone-elses-leftover',
    }))

    expect(onLogin).not.toHaveBeenCalled()
  })
})
