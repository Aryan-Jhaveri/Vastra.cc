import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SuggestTab } from '../../../src/components/home/SuggestTab'
import { createOutfit } from '../../../src/api/outfits'

const mockSubmit = vi.fn().mockResolvedValue(undefined)
const mockClear = vi.fn()
const mockReshuffleItems = vi.fn()
const mockReshuffleOutfits = vi.fn()

let mockPhase: string = 'idle'
let mockError: string | null = null
let mockSuggestions: any[] | null = null

vi.mock('../../../src/hooks/useDiscoverStream', () => ({
  useDiscoverStream: () => ({
    phase: mockPhase,
    error: mockError,
    submit: mockSubmit,
    clear: mockClear,
    reshuffleItems: mockReshuffleItems,
    reshuffleOutfits: mockReshuffleOutfits,
    visibleItems: null,
    visibleOutfits: null,
    hasMoreItems: false,
    hasMoreOutfits: false,
    suggestions: mockSuggestions,
    contextDescription: null,
    retrievalMode: null,
    shortlist: null,
    shortlistPool: null,
    shortlistSource: null,
    relatedOutfits: null,
    relatedOutfitsPool: null,
    relatedOutfitsSource: null,
  }),
  UseDiscoverStreamReturn: {} as any,
  StreamPayload: {} as any,
}))

vi.mock('../../../src/components/home/SuggestOccasionGrid', () => ({
  SuggestOccasionGrid: vi.fn(({ selected, onSelect }: any) => (
    <div data-testid="occasion-grid">
      <span data-testid="selected-occasion">{selected ?? 'none'}</span>
      <button data-testid="select-work" onClick={() => onSelect('work')}>Select Work</button>
      <button data-testid="deselect" onClick={() => onSelect(null)}>Deselect</button>
    </div>
  )),
  SELECTED_KEY: 'suggest-selected-occasion',
}))

let lastOutfitDetailProps: any = null
vi.mock('../../../src/components/home/PhasedSuggestionLayout', () => ({
  PhasedSuggestionLayout: vi.fn(({ stream, onRegenerate, onSave, onView, savedIds }: any) => {
    const suggestion = stream.suggestions?.[0]
    return (
      <div data-testid="phased-layout">
        <span data-testid="stream-phase">{stream.phase}</span>
        {onRegenerate && <button data-testid="regenerate" onClick={onRegenerate}>Regenerate</button>}
        {suggestion && (
          <div>
            {savedIds?.has?.(suggestion.name) ? (
              <button data-testid="view-outfit" onClick={() => onView?.(suggestion)}>View outfit</button>
            ) : (
              <button data-testid="save-outfit" onClick={() => onSave?.(suggestion)}>Save outfit</button>
            )}
          </div>
        )}
      </div>
    )
  }),
}))

vi.mock('../../../src/api/outfits', () => ({
  createOutfit: vi.fn(),
}))

vi.mock('../../../src/modals/OutfitDetail', () => ({
  OutfitDetail: vi.fn((props: any) => {
    lastOutfitDetailProps = props
    return (
      <div data-testid="outfit-detail">
        <span data-testid="outfit-detail-id">{props.outfit?.id ?? 'no-id'}</span>
        <button data-testid="close-outfit" onClick={props.onClose}>Close</button>
      </div>
    )
  }),
}))

const mockLocation = { lat: 52, lon: 13, name: 'Berlin' }

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  mockPhase = 'idle'
  mockError = null
  mockSuggestions = null
  lastOutfitDetailProps = null
  mockClear.mockImplementation(() => {
    mockPhase = 'idle'
    mockError = null
  })
  vi.mocked(createOutfit).mockReset()
})

function renderTab(location = mockLocation) {
  return render(<SuggestTab location={location as any} />)
}

describe('SuggestTab — state machine', () => {
  it('idle: renders chip grid + Suggest button, no results, no Clear All', async () => {
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('occasion-grid')).toBeInTheDocument() })
    expect(screen.getByText('Suggest')).toBeInTheDocument()
    expect(screen.queryByTestId('phased-layout')).not.toBeInTheDocument()
    expect(screen.queryByText('Clear all')).not.toBeInTheDocument()
  })

  it('no location: shows location prompt instead of grid', async () => {
    render(<SuggestTab location={null} />)
    expect(screen.getByText(/Set your location/)).toBeInTheDocument()
    expect(screen.queryByTestId('occasion-grid')).not.toBeInTheDocument()
  })

  it('in active phase: chip grid hidden, results + Clear All visible (two places)', async () => {
    mockPhase = 'done'
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })

    expect(screen.queryByTestId('occasion-grid')).not.toBeInTheDocument()
    expect(screen.getByTestId('phased-layout')).toBeInTheDocument()

    // Two Clear All buttons
    const clearButtons = screen.getAllByText('Clear all')
    expect(clearButtons.length).toBe(2)
  })

  it('Clicking Suggest calls submit with occasion from selection', async () => {
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('occasion-grid')).toBeInTheDocument() })

    // First select Work
    await userEvent.click(screen.getByTestId('select-work'))

    // Then click Suggest
    await userEvent.click(screen.getByText('Suggest'))

    expect(mockSubmit).toHaveBeenCalledWith('weather', {
      coords: { lat: 52, lon: 13 },
      occasion: 'work',
    })
  })

  it('Clicking Suggest without occasion selection omits occasion', async () => {
    renderTab()

    await waitFor(() => { expect(screen.getByText('Suggest')).toBeInTheDocument() })
    await userEvent.click(screen.getByText('Suggest'))

    expect(mockSubmit).toHaveBeenCalledWith('weather', {
      coords: { lat: 52, lon: 13 },
      occasion: undefined,
    })
  })

  it('header Clear All returns to idle, clears selection', async () => {
    mockPhase = 'done'
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })

    // Click top (header) Clear All
    const clearButtons = screen.getAllByText('Clear all')
    await userEvent.click(clearButtons[0])

    expect(mockClear).toHaveBeenCalled()
  })

  it('bottom Clear All also returns to idle', async () => {
    mockPhase = 'done'
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })

    const clearButtons = screen.getAllByText('Clear all')
    await userEvent.click(clearButtons[1])

    expect(mockClear).toHaveBeenCalled()
  })

  it('Regenerate sends isRegenerate:true with the current weather context', async () => {
    mockPhase = 'done'
    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    await userEvent.click(screen.getByTestId('regenerate'))

    expect(mockSubmit).toHaveBeenCalledWith('weather', {
      coords: { lat: 52, lon: 13 },
      occasion: undefined,
      isRegenerate: true,
    })
  })
})

describe('SuggestTab — saved-map persistence (#238, #239)', () => {
  const mockSuggestion = {
    name: 'Casual Friday',
    item_ids: ['item_1', 'item_2'],
    occasion: 'casual',
    reasoning: 'Looks good',
    items: [],
  }

  it('#239 — saved state survives remount', async () => {
    mockPhase = 'done'
    mockSuggestions = [mockSuggestion]
    vi.mocked(createOutfit).mockResolvedValue({ id: 'outfit_abc' } as any)

    const { unmount } = renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    await userEvent.click(screen.getByTestId('save-outfit'))
    await waitFor(() => { expect(screen.getByTestId('view-outfit')).toBeInTheDocument() })

    expect(sessionStorage.getItem('suggest-saved-map')).toContain('outfit_abc')

    unmount()
    vi.clearAllMocks()

    // Remount — savedMap should restore from sessionStorage
    render(<SuggestTab location={mockLocation as any} />)

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    expect(screen.getByTestId('view-outfit')).toBeInTheDocument()
    expect(screen.queryByTestId('save-outfit')).not.toBeInTheDocument()
  })

  it('#238 — view outfit uses real outfit id after save', async () => {
    mockPhase = 'done'
    mockSuggestions = [mockSuggestion]
    vi.mocked(createOutfit).mockResolvedValue({ id: 'real_outfit_123' } as any)

    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    await userEvent.click(screen.getByTestId('save-outfit'))
    await waitFor(() => { expect(screen.getByTestId('view-outfit')).toBeInTheDocument() })

    await userEvent.click(screen.getByTestId('view-outfit'))
    await waitFor(() => { expect(screen.getByTestId('outfit-detail')).toBeInTheDocument() })
    expect(screen.getByTestId('outfit-detail-id')).toHaveTextContent('real_outfit_123')
  })

  it('clear-all removes saved-map from state and sessionStorage', async () => {
    mockPhase = 'done'
    mockSuggestions = [mockSuggestion]
    vi.mocked(createOutfit).mockResolvedValue({ id: 'outfit_abc' } as any)

    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    await userEvent.click(screen.getByTestId('save-outfit'))

    await waitFor(() => { expect(screen.getByTestId('view-outfit')).toBeInTheDocument() })
    expect(sessionStorage.getItem('suggest-saved-map')).toContain('outfit_abc')

    await userEvent.click(screen.getAllByText('Clear all')[0])

    expect(sessionStorage.getItem('suggest-saved-map')).toBeNull()
    // clear-all resets phase to idle → phased-layout and save-outfit unmount
    expect(screen.queryByTestId('phased-layout')).not.toBeInTheDocument()
    expect(screen.queryByTestId('save-outfit')).not.toBeInTheDocument()
  })

  it('createOutfit return value is stored in sessionStorage under suggestion name', async () => {
    mockPhase = 'done'
    mockSuggestions = [mockSuggestion]
    vi.mocked(createOutfit).mockResolvedValue({ id: 'outfit_xyz' } as any)

    renderTab()

    await waitFor(() => { expect(screen.getByTestId('phased-layout')).toBeInTheDocument() })
    await userEvent.click(screen.getByTestId('save-outfit'))

    expect(JSON.parse(sessionStorage.getItem('suggest-saved-map')!)).toEqual({
      'Casual Friday': 'outfit_xyz',
    })
  })
})
