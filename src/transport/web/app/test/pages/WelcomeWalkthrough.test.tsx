import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const store: Record<string, string> = {}
beforeAll(() => {
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

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k])
})

vi.mock('../../src/components/LottieAnim', () => ({
  LottieAnim: ({ onComplete }: { onComplete?: () => void }) => (
    <div data-testid="lottie-anim">
      <button onClick={onComplete} data-testid="complete-btn">Complete</button>
    </div>
  ),
}))

let WelcomeWalkthrough: typeof import('../../src/pages/WelcomeWalkthrough').WelcomeWalkthrough
beforeAll(async () => {
  WelcomeWalkthrough = (await import('../../src/pages/WelcomeWalkthrough')).WelcomeWalkthrough
})

function renderWalkthrough(onComplete = vi.fn()) {
  return render(
    <MemoryRouter>
      <WelcomeWalkthrough onComplete={onComplete} />
    </MemoryRouter>,
  )
}

describe('WelcomeWalkthrough', () => {
  it('renders only 1 LottieAnim (single slide)', () => {
    renderWalkthrough()
    expect(screen.getAllByTestId('lottie-anim')).toHaveLength(1)
  })

  it('skip button sets closet_walkedthrough and shows guide CTA', () => {
    renderWalkthrough()
    expect(store['closet_walkedthrough']).toBeUndefined()

    fireEvent.click(screen.getByText('Skip'))

    expect(store['closet_walkedthrough']).toBe('true')
    expect(screen.getByText(/full guide is available in Settings/i)).toBeInTheDocument()
  })

  it('animation completion sets closet_walkedthrough and shows guide CTA', () => {
    renderWalkthrough()
    expect(store['closet_walkedthrough']).toBeUndefined()

    fireEvent.click(screen.getByTestId('complete-btn'))

    expect(store['closet_walkedthrough']).toBe('true')
    expect(screen.getByText(/full guide is available in Settings/i)).toBeInTheDocument()
  })

  it('does not show a View Guide button after animation completes', () => {
    renderWalkthrough()

    fireEvent.click(screen.getByTestId('complete-btn'))

    expect(screen.queryByRole('button', { name: 'View Guide' })).not.toBeInTheDocument()
  })

  it('Continue button calls onComplete', () => {
    const onComplete = vi.fn()
    renderWalkthrough(onComplete)

    fireEvent.click(screen.getByTestId('complete-btn'))
    fireEvent.click(screen.getByText('Continue'))

    expect(onComplete).toHaveBeenCalled()
  })
})
