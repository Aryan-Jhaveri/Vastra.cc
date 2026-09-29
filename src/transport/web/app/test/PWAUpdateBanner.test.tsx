import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PWAUpdateBanner } from '../src/components/PWAUpdateBanner'

const mockUseRegisterSW = vi.fn()

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (...args: unknown[]) => mockUseRegisterSW(...args),
}))

const swAddEventListener = vi.fn()
const swRemoveEventListener = vi.fn()

describe('PWAUpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { addEventListener: swAddEventListener, removeEventListener: swRemoveEventListener },
    })
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [false, vi.fn()] as [boolean, (v: boolean) => void],
      updateServiceWorker: vi.fn(),
    })
  })

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
  })

  it('renders nothing when needRefresh is false', () => {
    render(<PWAUpdateBanner />)
    expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
  })

  it('renders banner when needRefresh is true', () => {
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()] as [boolean, (v: boolean) => void],
      updateServiceWorker: vi.fn(),
    })
    render(<PWAUpdateBanner />)
    expect(screen.getByText('Update ready')).toBeInTheDocument()
    expect(screen.getByText('Tap to load the latest version')).toBeInTheDocument()
    expect(screen.getByText('Update')).toBeInTheDocument()
    expect(screen.getByText('Later')).toBeInTheDocument()
  })

  it('calls updateServiceWorker(true) when Update is clicked', () => {
    const updateSW = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, vi.fn()] as [boolean, (v: boolean) => void],
      updateServiceWorker: updateSW,
    })
    render(<PWAUpdateBanner />)
    fireEvent.click(screen.getByText('Update'))
    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('calls setNeedRefresh(false) when Later is clicked', () => {
    const setNeedRefresh = vi.fn()
    mockUseRegisterSW.mockReturnValue({
      needRefresh: [true, setNeedRefresh] as [boolean, (v: boolean) => void],
      updateServiceWorker: vi.fn(),
    })
    render(<PWAUpdateBanner />)
    fireEvent.click(screen.getByText('Later'))
    expect(setNeedRefresh).toHaveBeenCalledWith(false)
  })

  it('adds a controllerchange listener on mount and removes it on unmount', () => {
    const { unmount } = render(<PWAUpdateBanner />)
    expect(swAddEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function))
    unmount()
    expect(swRemoveEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function))
  })

  it('calls registration.update() on visibilitychange when the document is visible', () => {
    const update = vi.fn()
    mockUseRegisterSW.mockImplementation((opts: { onRegistered?: (r: unknown) => void }) => {
      opts?.onRegistered?.({ update })
      return {
        needRefresh: [false, vi.fn()] as [boolean, (v: boolean) => void],
        updateServiceWorker: vi.fn(),
      }
    })
    render(<PWAUpdateBanner />)
    fireEvent(document, new Event('visibilitychange'))
    expect(update).toHaveBeenCalled()
  })
})
