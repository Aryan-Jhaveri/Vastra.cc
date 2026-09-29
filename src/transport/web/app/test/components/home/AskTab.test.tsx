import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

vi.mock('../../../src/api/client', () => ({
  apiFetch: vi.fn(),
  apiFetchJSON: vi.fn(),
  getImageSrc: (uri: string) => `/${uri}`,
}))

import { apiFetch, apiFetchJSON } from '../../../src/api/client'
import { AskTab } from '../../../src/components/home/AskTab'
import { CHAT_THREAD_KEY } from '../../../src/hooks/useChat'
import { resetShopEnabled } from '../../../src/hooks/useShopEnabled'
import { resetLikedIds } from '../../../src/components/chat/ToolResultView'

const apiFetchMock = vi.mocked(apiFetch)
const apiFetchJSONMock = vi.mocked(apiFetchJSON)

function sse(events: Record<string, unknown>[]): Response {
  const encoder = new TextEncoder()
  const chunks = events.map(e => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
  let i = 0
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
  } as unknown as Response
}

function renderTab() {
  return render(<MemoryRouter><AskTab /></MemoryRouter>)
}

function lastBody(): Record<string, unknown> {
  const init = apiFetchMock.mock.calls.at(-1)![1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

const item = (id: string) => ({ id, imageUri: `images/items/${id}.jpg`, category: 'tops' })

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  resetShopEnabled()
  resetLikedIds()
  // jsdom has no scrolling; the tab follows new output with window.scrollTo.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ shopEnabled: false }) })))
})

describe('AskTab', () => {
  it('a starter chip sends a message and message_delta events build the reply', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'thread', threadId: 'th_1', title: 'What should I wear today?' },
      { type: 'status', step: 1, status: 'thinking' },
      { type: 'message_delta', text: 'Try the ' },
      { type: 'message_delta', text: 'navy chinos.' },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()

    fireEvent.click(screen.getByText('What should I wear today?'))

    await screen.findByText('Try the navy chinos.')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/chat/stream', expect.objectContaining({ method: 'POST' }))
    expect(lastBody()).toEqual({ message: 'What should I wear today?', timeZone: expect.any(String) })
    expect(sessionStorage.getItem(CHAT_THREAD_KEY)).toBe('th_1')
  })

  it('continues the same thread on the next message', async () => {
    apiFetchMock
      .mockResolvedValueOnce(sse([{ type: 'thread', threadId: 'th_9', title: 'hi' }, { type: 'message_delta', text: 'hello' }, { type: 'done', finishReason: 'stop', steps: 1 }]))
      .mockResolvedValueOnce(sse([{ type: 'message_delta', text: 'again' }, { type: 'done', finishReason: 'stop', steps: 1 }]))
    renderTab()
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'hi' } })
    fireEvent.submit(box.closest('form')!)
    await screen.findByText('hello')
    fireEvent.change(box, { target: { value: 'more' } })
    fireEvent.submit(box.closest('form')!)
    await screen.findByText('again')
    expect(lastBody()).toEqual({ threadId: 'th_9', message: 'more', timeZone: expect.any(String) })
  })

  it('renders item results with ClosetItemMini and outfit results with SavedOutfitCard', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'c1', name: 'search_closet', args: {} },
      { type: 'tool_result', id: 'c1', name: 'search_closet', result: { results: [item('a'), item('b')], truncated: false, total: 2 } },
      { type: 'tool_preview', id: 'c2', name: 'get_outfit', args: { id: 'o1' } },
      { type: 'tool_result', id: 'c2', name: 'get_outfit', result: { id: 'o1', name: 'Weekend', occasion: 'casual', season: ['fall'], tags: [], itemIds: ['a'], coverImageUri: null, items: [item('a')] } },
      { type: 'done', finishReason: 'stop', steps: 2 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What goes with my navy chinos?'))

    const items = await screen.findByTestId('tool-items')
    expect(items.querySelectorAll('img')).toHaveLength(2)
    expect(screen.getByTestId('tool-outfit')).toHaveTextContent('Weekend')
  })

  it('confirmation_required renders Confirm / Cancel; Confirm posts only the action id', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'cw', name: 'create_outfit', args: { name: 'Date night', item_ids: ['a', 'b'] } },
      { type: 'confirmation_required', id: 'pa_1', toolCallId: 'cw', toolName: 'create_outfit', args: { name: 'Date night', item_ids: ['a', 'b'] }, expiresAt: Date.now() + 300_000 },
      { type: 'done', finishReason: 'confirmation_required', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('Plan outfits for a 3-day trip'))

    const card = await screen.findByTestId('confirm-card')
    expect(card).toHaveTextContent('“Date night” · 2 items')

    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_result', id: 'cw', name: 'create_outfit', result: { id: 'o9', name: 'Date night', occasion: null } },
      { type: 'message_delta', text: 'Saved!' },
      { type: 'done', finishReason: 'stop', steps: 2 },
    ]))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await screen.findByText('Saved!')
    expect(apiFetchMock.mock.calls.at(-1)![0]).toBe('/api/chat/confirm')
    expect(lastBody()).toEqual({ actionId: 'pa_1', timeZone: expect.any(String) })
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('a collection write shows the server summary and renders the collection once confirmed (#338)', async () => {
    const args = { collection_id: 'col_1', outfit_ids: ['o1', 'o2'] }
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'ca', name: 'add_outfits_to_collection', args },
      { type: 'confirmation_required', id: 'pa_c', toolCallId: 'ca', toolName: 'add_outfits_to_collection', args, expiresAt: Date.now() + 300_000, summary: 'Add 2 outfits to “Toronto trip”' },
      { type: 'done', finishReason: 'confirmation_required', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('Plan outfits for a 3-day trip'))

    const card = await screen.findByTestId('confirm-card')
    expect(card).toHaveTextContent('Add to collection')
    expect(card).toHaveTextContent('Add 2 outfits to “Toronto trip”')
    expect(card).not.toHaveTextContent('col_1')

    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_result', id: 'ca', name: 'add_outfits_to_collection', result: {
        id: 'col_1', name: 'Toronto trip', description: null, coverImageUri: null, season: [], tags: [],
        outfits: [{ id: 'o1', name: 'Work', itemIds: ['i1'], items: [item('i1')] }, { id: 'o2', name: 'Drinks', itemIds: ['i2'], items: [item('i2')] }],
        truncated: false, total: 2,
      } },
      { type: 'done', finishReason: 'stop', steps: 2 },
    ]))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByTestId('tool-collection')).toHaveTextContent('Toronto trip')
  })

  it('get_forecast renders one row per day (#338)', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'cf', name: 'get_forecast', args: { location: 'Toronto' } },
      { type: 'tool_result', id: 'cf', name: 'get_forecast', result: {
        location: { name: 'Toronto, Canada' },
        days: [
          { date: '2026-10-02', tempMax: 14.4, tempMin: 6, condition: 'Overcast', precipitationProbability: 10 },
          { date: '2026-10-03', tempMax: 12, tempMin: 5, condition: 'Slight rain', precipitationProbability: 80 },
        ],
      } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('Plan outfits for a 3-day trip'))
    const forecast = await screen.findByTestId('tool-forecast')
    expect(forecast).toHaveTextContent('Toronto, Canada')
    expect(forecast).toHaveTextContent('Slight rain')
    expect(forecast).toHaveTextContent('80%')
    expect(forecast).toHaveTextContent('14° / 6°')
  })

  it('a cancelled or expired confirmation shows as declined', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'confirmation_required', id: 'pa_2', toolCallId: 'cx', toolName: 'create_outfit', args: { name: 'X', item_ids: ['a'] }, expiresAt: 0 },
      { type: 'done', finishReason: 'confirmation_required', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    await screen.findByTestId('confirm-card')

    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_result', id: 'cx', name: 'create_outfit', result: { declined: true, reason: 'user_cancelled' } },
      { type: 'done', finishReason: 'stop', steps: 2 },
    ]))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByTestId('confirm-declined')).toHaveTextContent('Declined')
    expect(apiFetchMock.mock.calls.at(-1)![0]).toBe('/api/chat/cancel')
  })

  it('INSUFFICIENT_TOKENS opens the top-up dialog (402 before streaming)', async () => {
    const listener = vi.fn()
    window.addEventListener('insufficient-tokens', listener)
    apiFetchMock.mockResolvedValueOnce({
      ok: false, status: 402,
      json: async () => ({ error: 'Insufficient tokens', code: 'INSUFFICIENT_TOKENS', required: 1, balance: 0 }),
    } as unknown as Response)
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    await waitFor(() => expect(listener).toHaveBeenCalled())
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ required: 1, balance: 0 })
    window.removeEventListener('insufficient-tokens', listener)
  })

  it('INSUFFICIENT_TOKENS as a stream error event also opens the dialog', async () => {
    const listener = vi.fn()
    window.addEventListener('insufficient-tokens', listener)
    apiFetchMock.mockResolvedValueOnce(sse([{ type: 'error', error: 'Insufficient tokens: need 1, have 0', code: 'INSUFFICIENT_TOKENS' }]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    await waitFor(() => expect(listener).toHaveBeenCalled())
    window.removeEventListener('insufficient-tokens', listener)
  })

  it('reload restores the transcript from GET /api/chat/threads/:id', async () => {
    sessionStorage.setItem(CHAT_THREAD_KEY, 'th_saved')
    apiFetchJSONMock.mockResolvedValueOnce({
      thread: { id: 'th_saved', title: 'Old chat', updatedAt: 1 },
      messages: [
        { id: 'm1', role: 'user', content: 'earlier question', turnId: 't', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'earlier answer', turnId: 't', createdAt: 2, toolCalls: [{ id: 'cw', name: 'create_outfit', arguments: { name: 'Kept', item_ids: ['a'] } }] },
      ],
      pendingActions: [{ id: 'pa_live', toolCallId: 'cw', toolName: 'create_outfit', args: { name: 'Kept', item_ids: ['a'] }, expiresAt: Date.now() + 1000 }],
    })
    renderTab()

    await screen.findByText('earlier answer')
    expect(apiFetchJSONMock).toHaveBeenCalledWith('/api/chat/threads/th_saved')
    expect(screen.getByText('earlier question')).toBeInTheDocument()
    expect(screen.getByText('Old chat')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  })

  it('the thread list shows titles and opens a thread', async () => {
    apiFetchJSONMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/chat/threads/th_b')) {
        return { thread: { id: 'th_b', title: 'Trip plan', updatedAt: 2 }, messages: [{ id: 'm', role: 'user', content: 'pack for Lisbon', turnId: 't', createdAt: 1 }], pendingActions: [] }
      }
      return { threads: [{ id: 'th_a', title: 'Navy chinos', updatedAt: 3 }, { id: 'th_b', title: 'Trip plan', updatedAt: 2 }], nextBefore: null }
    })
    renderTab()
    fireEvent.click(screen.getByLabelText('Past chats'))
    const list = await screen.findByTestId('thread-list')
    await waitFor(() => expect(list).toHaveTextContent('Navy chinos'))
    await act(async () => { fireEvent.click(screen.getByText('Trip plan')) })
    await screen.findByText('pack for Lisbon')
    expect(sessionStorage.getItem(CHAT_THREAD_KEY)).toBe('th_b')
  })
})

// ─── #339 layout + #341 shop results ───────────────────────────────────────────

function mockJson(routes: Record<string, unknown>) {
  apiFetchJSONMock.mockImplementation(async (url: string) => routes[url] as never)
}

function shopOn() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ shopEnabled: true }) })))
}

const shopProduct = (id: string, title: string) => ({
  id: `gid://shopify/p/${id}`, title, imageUrl: null, price: '40 CAD', merchant: 'Shop', url: `https://shop.example/${id}`, available: true,
})

describe('AskTab — layout (#339)', () => {
  it('the composer sits outside the transcript, in a fixed footer of one height, even with a long draft', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'message_delta', text: 'hi there' },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    const transcript = await screen.findByTestId('transcript')
    const composer = screen.getByTestId('composer')
    expect(transcript.contains(composer)).toBe(false)
    expect(composer.className).toContain('fixed')
    const box = screen.getByLabelText('Message')
    fireEvent.change(box, { target: { value: 'x'.repeat(1500) } })
    expect(composer.style.height).toBe('62px')
    expect(box.tagName).toBe('INPUT')
    expect(screen.queryByLabelText(/attach/i)).toBeNull()
  })

  it('labels bubbles "You" / "Vastra" and groups consecutive tools into one pill', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 't1', name: 'get_weather', args: {} },
      { type: 'tool_preview', id: 't2', name: 'search_closet', args: {} },
      { type: 'tool_result', id: 't1', name: 'get_weather', result: { location: { name: 'Toronto' }, weather: { temperature: 18, weatherCode: 61, condition: 'Light rain', precipitation: 1, windSpeed: 10, icon: '' } } },
      { type: 'tool_result', id: 't2', name: 'search_closet', result: { results: [item('a')], truncated: false, total: 1 } },
      { type: 'message_delta', text: 'Wear the jacket.' },
      { type: 'done', finishReason: 'stop', steps: 2 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    await screen.findByText('Wear the jacket.')
    expect(screen.getAllByTestId('tool-pill')).toHaveLength(1)
    expect(screen.getByTestId('tool-pill')).toHaveTextContent('Checked weather · Searched your closet')
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Vastra')).toBeInTheDocument()
    expect(screen.getByTestId('user-message')).toHaveTextContent('What should I wear today?')
  })

  it('the Confirm card carries the mock badge', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'confirmation_required', id: 'pa_b', toolCallId: 'cb', toolName: 'create_outfit', args: { name: 'Rainy Tuesday', item_ids: ['a'] }, expiresAt: Date.now() + 300_000, summary: '“Rainy Tuesday” · 1 item' },
      { type: 'done', finishReason: 'confirmation_required', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    expect(await screen.findByTestId('confirm-card')).toHaveTextContent('Save outfit · confirm')
  })

  it('shows the token hint only when billing is on', async () => {
    mockJson({ '/api/chat/allowance': { billing: true, tokensPerMessage: 1, freePerDay: 10, freeLeft: 7 } })
    const { unmount } = renderTab()
    expect(await screen.findByTestId('allowance-hint')).toHaveTextContent('1 token per message · 7 free today')
    unmount()

    mockJson({ '/api/chat/allowance': { billing: false } })
    renderTab()
    await waitFor(() => expect(apiFetchJSONMock).toHaveBeenCalledWith('/api/chat/allowance'))
    expect(screen.queryByTestId('allowance-hint')).toBeNull()
  })
})

describe('AskTab — shop (#341)', () => {
  it('the shop starter shows only while the shop is on', async () => {
    const { unmount } = renderTab()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText('Show me shop items like this')).toBeNull()
    unmount()

    resetShopEnabled()
    shopOn()
    renderTab()
    expect(await screen.findByText('Show me shop items like this')).toBeInTheDocument()
  })

  it('search_shop results render ProductCards; ♡ calls the likes route; More pages the live catalog', async () => {
    mockJson({ '/api/shop/likes/ids': { productIds: ['gid://shopify/p/2'] } })
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 's1', name: 'search_shop', args: { query: 'red shirt' } },
      { type: 'tool_result', id: 's1', name: 'search_shop', result: {
        query: 'red shirt', products: [shopProduct('1', 'Red Linen Shirt'), shopProduct('2', 'Crimson Tee')], nextCursor: 'cur1', ranked: false,
      } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What goes with my navy chinos?'))

    const grid = await screen.findByTestId('tool-shop')
    expect(grid).toHaveTextContent('Red Linen Shirt')
    expect(grid).toHaveTextContent('Crimson Tee')
    expect(screen.getByTestId('tool-pill')).toHaveTextContent('Searched shop items')

    apiFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response)
    const hearts = await screen.findAllByRole('button', { name: /like/i })
    fireEvent.click(hearts[0])
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/shop/likes/${encodeURIComponent('gid://shopify/p/1')}`, expect.objectContaining({ method: 'PUT' }),
    ))

    apiFetchJSONMock.mockImplementation(async (url: string) => (url === '/api/shop/related'
      ? { products: [shopProduct('3', 'Scarlet Oxford')], nextCursor: null }
      : undefined) as never)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(await screen.findByText('Scarlet Oxford')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('a reloaded shop result flags delisted products', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'l1', name: 'list_liked_products', args: {} },
      { type: 'tool_result', id: 'l1', name: 'list_liked_products', result: { products: [shopProduct('1', 'Still Here')], gone: ['gid://shopify/p/9'], total: 2 } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    expect(await screen.findByText('1 product is no longer listed.')).toBeInTheDocument()
  })
})

describe('AskTab — View / Open (#339)', () => {
  it('an item thumbnail opens ItemDetail with the full item', async () => {
    mockJson({ '/api/items/a/images': [], '/api/items/a': { ...item('a'), subcategory: 'Oxford shirt', colors: '[]', season: '[]', occasion: '[]', tags: '[]', timesWorn: 0, createdAt: 0, updatedAt: 0 } })
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 's', name: 'search_closet', args: {} },
      { type: 'tool_result', id: 's', name: 'search_closet', result: { results: [item('a')], truncated: false, total: 1 } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What goes with my navy chinos?'))
    const items = await screen.findByTestId('tool-items')
    fireEvent.click(items.querySelector('button')!)
    await waitFor(() => expect(apiFetchJSONMock).toHaveBeenCalledWith('/api/items/a'))
    expect(await screen.findByTestId('itemdetail-actions')).toBeInTheDocument()
  })

  it('an outfit row View fetches the outfit and opens OutfitDetail', async () => {
    mockJson({ '/api/outfits/o1': { id: 'o1', name: 'Weekend Brunch', itemIds: '["a"]', occasion: 'casual', season: '[]', tags: '[]', aiGenerated: 0, weatherContext: null, notes: null, coverImageUri: null, timesWorn: 0, lastWornAt: null, createdAt: 0, items: [item('a')] } })
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'l', name: 'list_outfits', args: {} },
      { type: 'tool_result', id: 'l', name: 'list_outfits', result: { results: [{ id: 'o1', name: 'Weekend Brunch', occasion: 'casual' }], truncated: false, total: 1 } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    const rows = await screen.findByTestId('tool-outfits')
    fireEvent.click(within(rows).getByRole('button', { name: 'View' }))
    await waitFor(() => expect(apiFetchJSONMock).toHaveBeenCalledWith('/api/outfits/o1'))
    await waitFor(() => expect(screen.getAllByText('Weekend Brunch').length).toBeGreaterThan(1))
  })

  it('a suggestion View opens OutfitDetail without a fetch', async () => {
    apiFetchMock.mockResolvedValueOnce(sse([
      { type: 'tool_preview', id: 'g', name: 'suggest_outfit', args: {} },
      { type: 'tool_result', id: 'g', name: 'suggest_outfit', result: { suggestions: [{ name: 'Rainy Tuesday', occasion: 'casual', reasoning: 'r', item_ids: ['a'], items: [item('a')] }] } },
      { type: 'done', finishReason: 'stop', steps: 1 },
    ]))
    renderTab()
    fireEvent.click(screen.getByText('What should I wear today?'))
    fireEvent.click(await screen.findByRole('button', { name: 'View' }))
    await waitFor(() => expect(screen.getAllByText('Rainy Tuesday').length).toBeGreaterThan(1))
    expect(apiFetchJSONMock).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/outfits\//))
  })
})
