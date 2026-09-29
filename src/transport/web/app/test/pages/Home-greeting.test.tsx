import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const store: Record<string, string> = {}
beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k])
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { Object.keys(store).forEach(k => delete store[k]) },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    } as Storage,
    writable: true,
    configurable: true,
  })
})

const mockGetMe = vi.fn()
vi.mock('../../src/api/auth', () => ({
  getMe: mockGetMe,
  patchMe: vi.fn(),
}))

vi.mock('../../src/hooks/useLocation', () => ({
  useLocation: () => ({
    location: null,
    loading: false,
    geocode: vi.fn(),
    requestBrowserLocation: vi.fn(),
  }),
}))

vi.mock('../../src/api/outfits', () => ({
  fetchWeather: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../src/components/home/SuggestTab', () => ({
  SuggestTab: vi.fn(() => <div data-testid="suggest-tab" />),
}))

vi.mock('../../src/components/home/RemindersTab', () => ({
  RemindersTab: vi.fn(() => <div data-testid="reminders-tab" />),
}))

vi.mock('../../src/components/home/DiscoverTab', () => ({
  DiscoverTab: vi.fn(() => <div data-testid="discover-tab" />),
}))

vi.mock('../../src/components/home/TabStrip', () => ({
  TabStrip: vi.fn(({ active }: { active: string; onChange: (t: string) => void }) => (
    <div data-testid="tab-strip" data-active={active} />
  )),
}))

let Home: typeof import('../../src/pages/Home').Home

beforeEach(async () => {
  vi.clearAllMocks()
  const mod = await import('../../src/pages/Home')
  Home = mod.Home
})

describe('Home — greeting', () => {
  it('shows greeting ending with period when name is null', async () => {
    mockGetMe.mockResolvedValue({
      userId: 'u1',
      email: 'test@test.com',
      name: null,
    })

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => {
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1.textContent).toMatch(/\.$/)
    })
  })

  it('shows name in subtitle when name is set', async () => {
    mockGetMe.mockResolvedValue({
      userId: 'u1',
      email: 'test@test.com',
      name: 'Alice',
    })

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => {
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1.textContent).toMatch(/Good (morning|afternoon|evening)\./)
      expect(screen.getByText('Alice')).toBeInTheDocument()
    })
  })

  it('keeps period on greeting even when name is set', async () => {
    mockGetMe.mockResolvedValue({
      userId: 'u1',
      email: 'test@test.com',
      name: 'Bob',
    })

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => {
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1.textContent).toMatch(/\.$/)
      expect(screen.getByText('Bob')).toBeInTheDocument()
    })
  })

  it('falls back to period-only greeting when name is empty string', async () => {
    mockGetMe.mockResolvedValue({
      userId: 'u1',
      email: 'test@test.com',
      name: '',
    })

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => {
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1.textContent).toMatch(/\.$/)
      expect(h1.textContent).not.toContain(',')
    })
  })
})
