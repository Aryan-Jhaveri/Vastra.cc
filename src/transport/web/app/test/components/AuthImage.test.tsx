import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'

import { installMockIntersectionObserver } from '../helpers/mockIntersectionObserver'

const mockFetch = vi.fn()

import { AuthImage } from '../../src/components/AuthImage'

describe('AuthImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations and unconsumed ...Once queues, so a
    // fetch mock from one test leaked into the next (order-dependent). Reset it
    // and give every test a deterministic default: unmocked fetches reject.
    mockFetch.mockReset()
    mockFetch.mockImplementation(() => Promise.reject(new Error('unmocked fetch')))
    globalThis.fetch = mockFetch as unknown as typeof fetch
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders missing-file badge when image fetch fails', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('Failed')))

    render(
      <AuthImage
        src="/images/items/missing.jpg"
        alt="Missing item"
        className="absolute inset-0 h-full w-full"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('missing file')).toBeInTheDocument()
    })
  })

  it('renders missing-file badge when img onError fires after successful fetch', async () => {
    const blob = new Blob(['fake'], { type: 'image/jpeg' })
    // Fresh Response per call: the fetch effect can run more than once, and a
    // Response body can only be read once.
    mockFetch.mockImplementation(() => Promise.resolve(new Response(blob, { status: 200 })))
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(_blob: Blob) {
          return 'blob:test-broken'
        }
        static revokeObjectURL(_url: string) {}
      },
    )

    render(
      <AuthImage
        src="/images/items/broken.jpg"
        alt="Broken item"
        className="absolute inset-0 h-full w-full"
      />,
    )

    // Fetch succeeded: the object URL is attached and no badge is shown yet.
    const img = screen.getByAltText('Broken item')
    await waitFor(() => expect(img).toHaveAttribute('src', 'blob:test-broken'))
    expect(screen.queryByText('missing file')).not.toBeInTheDocument()

    // The browser then fails to decode the image.
    fireEvent.error(img)

    await waitFor(() => {
      expect(screen.getByText('missing file')).toBeInTheDocument()
    })
  })

  it('resets error state when src changes and new fetch succeeds', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('Failed')))

    const { rerender } = render(
      <AuthImage
        src="/images/items/missing.jpg"
        alt="Missing"
        className="absolute inset-0"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('missing file')).toBeInTheDocument()
    })

    const okBlob = new Blob(['ok'], { type: 'image/jpeg' })
    mockFetch.mockResolvedValueOnce(new Response(okBlob, { status: 200 }))

    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(_blob: Blob) {
          return 'blob:test-ok'
        }
        static revokeObjectURL(_url: string) {}
      },
    )

    rerender(
      <AuthImage
        src="/images/items/now-valid.jpg"
        alt="Now valid"
        className="absolute inset-0"
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('missing file')).not.toBeInTheDocument()
    })
  })

  it('does not fetch until element intersects when lazy=true', async () => {
    const io = installMockIntersectionObserver()

    render(
      <AuthImage
        src="/images/items/lazy.jpg"
        alt="Lazy image"
        className="absolute inset-0"
        lazy
      />,
    )

    expect(mockFetch).not.toHaveBeenCalled()

    act(() => {
      io.lastCallback([{ isIntersecting: true }])
    })

    await waitFor(() => {
      // Cookie-only fetch: no init/headers — the httpOnly cookie rides the
      // same-origin request (#295).
      expect(mockFetch).toHaveBeenCalledWith('/images/items/lazy.jpg')
    })
  })

  it('sets wrapper background color from blob when fillBackground=true', async () => {
    installMockIntersectionObserver()

    const blob = new Blob(['test'], { type: 'image/jpeg' })
    mockFetch.mockResolvedValueOnce(new Response(blob, { status: 200 }))

    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(_blob: Blob) {
          return 'blob:test-bg'
        }
        static revokeObjectURL(_url: string) {}
      },
    )

    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: [100, 150, 200, 255] }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as any)

    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      src: string = ''
      constructor() {
        setTimeout(() => { if (this.onload) this.onload() }, 0)
      }
    })

    render(
      <AuthImage
        src="/images/items/bg.jpg"
        alt="BG image"
        className="absolute inset-0"
        fillBackground
      />,
    )

    await waitFor(() => {
      const wrapper = document.querySelector('.relative')
      expect(wrapper?.style.background).toBe('rgb(100, 150, 200)')
    })
  })

  it('reveal-card CSS contains reduced-motion override rule', () => {
    const style = document.createElement('style')
    style.textContent = [
      '.reveal-card { opacity: 0; transform: scale(0.96); transition: opacity 300ms ease-out, transform 300ms ease-out; }',
      '.reveal-card.reveal-card--visible { opacity: 1; transform: scale(1); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .reveal-card { opacity: 1; transform: none; transition: none; }',
      '}',
    ].join('\n')
    document.head.appendChild(style)

    const sheet = style.sheet as CSSStyleSheet
    const rules = Array.from(sheet.cssRules)
    const mediaRule = rules.find(r => r instanceof CSSMediaRule) as CSSMediaRule
    expect(mediaRule).toBeDefined()
    expect(mediaRule.conditionText).toBe('(prefers-reduced-motion: reduce)')

    const innerRule = mediaRule.cssRules[0] as CSSStyleRule
    expect(innerRule.selectorText).toBe('.reveal-card')
    expect(innerRule.style.opacity).toBe('1')
    expect(innerRule.style.transform).toBe('none')
    expect(innerRule.style.transition).toBe('none')
  })
})
