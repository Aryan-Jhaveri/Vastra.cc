import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { DiscoverTab } from '../../../src/components/home/DiscoverTab'
import { getShare } from '../../../src/api/share'

const mockSubmit = vi.fn().mockResolvedValue(undefined)
const mockClear = vi.fn()
let mockPhase: string = 'idle'

vi.mock('../../../src/hooks/useDiscoverStream', () => ({
  useDiscoverStream: () => ({
    phase: mockPhase,
    error: null,
    submit: mockSubmit,
    clear: mockClear,
    reshuffleItems: vi.fn(),
    reshuffleOutfits: vi.fn(),
    visibleItems: null,
    visibleOutfits: null,
    hasMoreItems: false,
    hasMoreOutfits: false,
    suggestions: null,
    contextDescription: null,
    retrievalMode: null,
    shortlist: null,
    shortlistPool: null,
    shortlistSource: null,
    relatedOutfits: null,
    relatedOutfitsPool: null,
    relatedOutfitsSource: null,
  }),
}))

vi.mock('../../../src/components/home/PhasedSuggestionLayout', () => ({
  PhasedSuggestionLayout: vi.fn(({ onRegenerate }: any) => (
    <div data-testid="phased-layout">
      {onRegenerate && <button data-testid="regenerate" onClick={onRegenerate}>Regenerate</button>}
    </div>
  )),
}))

vi.mock('../../../src/api/outfits', () => ({ createOutfit: vi.fn() }))
vi.mock('../../../src/api/share', () => ({ getShare: vi.fn() }))
vi.mock('../../../src/modals/OutfitDetail', () => ({ OutfitDetail: () => null }))
vi.mock('../../../src/components/SharePreviewCard', () => ({ SharePreviewCard: () => null }))
vi.mock('../../../src/lib/usePasteImage', () => ({ usePasteImage: vi.fn() }))

const mockLocation = { lat: 52, lon: 13, name: 'Berlin' }

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  // This jsdom build ships a non-functional localStorage; DiscoverTab reads it
  // on mount (pending-share check), so provide a minimal in-memory stub.
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  })
  mockPhase = 'idle'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderTab() {
  return render(
    <MemoryRouter>
      <DiscoverTab location={mockLocation as never} />
    </MemoryRouter>,
  )
}

describe('DiscoverTab — modes (#370: no Prompt)', () => {
  it('offers only Image and Link, with Image selected and no prompt box', () => {
    renderTab()
    expect(screen.queryByRole('button', { name: /prompt/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /looking for/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/what are you looking for/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /image/i, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /link/i, pressed: false })).toBeInTheDocument()
  })

  it('Link mode still submits a shared link', async () => {
    vi.mocked(getShare).mockResolvedValue({
      id: 'abc123xyz', source: 'outfit', description: '', imageUris: [], senderHandle: null, createdAt: 0, expiresAt: null, outfit: null,
    } as never)
    renderTab()
    await userEvent.click(screen.getByRole('button', { name: /link/i }))
    const input = screen.getByRole('textbox')
    await userEvent.type(input, 'https://vastra.cc/share/abc123xyz')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith('shared', expect.objectContaining({ shareId: 'abc123xyz' })))
    expect(mockSubmit).not.toHaveBeenCalledWith('prompt', expect.anything())
  })
})

describe('DiscoverTab — regenerate', () => {
  it('image mode: Regenerate sends isRegenerate:true (continuation pricing)', async () => {
    vi.mocked(getShare).mockResolvedValue({
      id: 'inbox-2', source: 'share_inbox', description: '', imageUris: ['images/share-inbox/y.jpg'],
      senderHandle: null, createdAt: 0, expiresAt: null, outfit: null,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['y'], { type: 'image/jpeg' }) }))
    mockPhase = 'done'
    render(
      <MemoryRouter initialEntries={['/?inboxId=inbox-2']}>
        <DiscoverTab location={mockLocation as never} />
      </MemoryRouter>,
    )
    await screen.findByAltText('inspiration')
    await userEvent.click(screen.getByTestId('regenerate'))
    expect(mockSubmit).toHaveBeenCalledWith('image', expect.objectContaining({ isRegenerate: true }))
  })
})

describe('DiscoverTab — PWA share inbox pre-load', () => {
  it('?inboxId loads the shared image into Image mode without auto-submitting', async () => {
    vi.mocked(getShare).mockResolvedValue({
      id: 'inbox-1',
      source: 'share_inbox',
      description: '',
      imageUris: ['images/share-inbox/x.jpg'],
      senderHandle: null,
      createdAt: 0,
      expiresAt: null,
      outfit: null,
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
    }))

    render(
      <MemoryRouter initialEntries={['/?inboxId=inbox-1']}>
        <DiscoverTab location={mockLocation as never} />
      </MemoryRouter>,
    )

    // Image-mode preview appears once the bytes are fetched + read into a File.
    expect(await screen.findByAltText('inspiration')).toBeInTheDocument()
    expect(getShare).toHaveBeenCalledWith('inbox-1')
    // Transparency: no auto-submit — the user presses Generate.
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})
