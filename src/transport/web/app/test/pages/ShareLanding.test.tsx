import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router'

vi.mock('../../src/lib/analytics', () => ({
  track: vi.fn(),
}))

import { ShareLanding } from '../../src/pages/ShareLanding'

// Probe that records the last client-side navigation target.
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}{location.hash}{location.search}</div>
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/share/:id" element={<ShareLanding />} />
        <Route path="/login" element={<LocationProbe />} />
        <Route path="/home" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ShareLanding — cookie-only session gate (#295)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('authed (cookie accepted by /api/auth/me) → straight to the Discover tab', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response)
    renderAt('/share/share-123')

    const loc = await screen.findByTestId('loc')
    expect(loc.textContent).toContain('/home')
    expect(loc.textContent).toContain('discover')
    expect(localStorage.getItem('closet-pending-share')).toBe('share-123')
    // No session token was written anywhere to decide this.
    expect(localStorage.getItem('closet-auth-token')).toBeNull()
    expect(sessionStorage.getItem('closet-auth-token')).toBeNull()
  })

  it('unauthenticated (401 from /api/auth/me) → redirected to /login', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as unknown as Response)
    renderAt('/share/share-456')

    const loc = await screen.findByTestId('loc')
    expect(loc.textContent).toBe('/login')
  })

  it('network error → /login (fail safe)', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('offline'))
    renderAt('/share/share-789')

    const loc = await screen.findByTestId('loc')
    expect(loc.textContent).toBe('/login')
  })
})