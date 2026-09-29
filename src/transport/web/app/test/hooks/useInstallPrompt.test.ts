import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('useInstallPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('returns canInstall=false when no beforeinstallprompt fires', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())
    expect(result.current.canInstall).toBe(false)
    expect(result.current.isInstalled).toBe(false)
  })

  it('sets canInstall=true when beforeinstallprompt fires', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())

    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const mockChoice = Promise.resolve({ outcome: 'accepted' as const })
    const event = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: string }>
    }
    Object.defineProperty(event, 'prompt', { value: mockPrompt })
    Object.defineProperty(event, 'userChoice', { value: mockChoice })

    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(result.current.canInstall).toBe(true)
    expect(result.current.isInstalled).toBe(false)
  })

  it('install() calls prompt and updates state on accepted', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())

    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const mockChoice = Promise.resolve({ outcome: 'accepted' as const })
    const event = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: string }>
    }
    Object.defineProperty(event, 'prompt', { value: mockPrompt })
    Object.defineProperty(event, 'userChoice', { value: mockChoice })

    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(result.current.canInstall).toBe(true)

    await act(async () => {
      await result.current.install()
    })

    expect(mockPrompt).toHaveBeenCalledOnce()
    expect(result.current.canInstall).toBe(false)
    expect(result.current.isInstalled).toBe(true)
  })

  it('install() keeps canInstall when user dismisses', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())

    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const mockChoice = Promise.resolve({ outcome: 'dismissed' as const })
    const event = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: string }>
    }
    Object.defineProperty(event, 'prompt', { value: mockPrompt })
    Object.defineProperty(event, 'userChoice', { value: mockChoice })

    await act(async () => {
      window.dispatchEvent(event)
    })

    await act(async () => {
      await result.current.install()
    })

    expect(mockPrompt).toHaveBeenCalledOnce()
    expect(result.current.canInstall).toBe(true)
    expect(result.current.isInstalled).toBe(false)
  })

  it('sets isInstalled when appinstalled event fires', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'))
    })

    expect(result.current.isInstalled).toBe(true)
    expect(result.current.canInstall).toBe(false)
  })

  it('detects standalone display-mode on mount', async () => {
    const origMatchMedia = window.matchMedia
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result } = renderHook(() => useInstallPrompt())

    expect(result.current.isInstalled).toBe(true)
    expect(result.current.canInstall).toBe(false)

    window.matchMedia = origMatchMedia
  })

  it('notifies all subscribers when beforeinstallprompt fires', async () => {
    const { initInstallPromptCapture, useInstallPrompt } = await import('../../src/hooks/useInstallPrompt')
    initInstallPromptCapture()
    const { result: result1 } = renderHook(() => useInstallPrompt())
    const { result: result2 } = renderHook(() => useInstallPrompt())

    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const mockChoice = Promise.resolve({ outcome: 'accepted' as const })
    const event = new Event('beforeinstallprompt') as Event & {
      prompt: () => Promise<void>
      userChoice: Promise<{ outcome: string }>
    }
    Object.defineProperty(event, 'prompt', { value: mockPrompt })
    Object.defineProperty(event, 'userChoice', { value: mockChoice })

    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(result1.current.canInstall).toBe(true)
    expect(result2.current.canInstall).toBe(true)
  })
})
