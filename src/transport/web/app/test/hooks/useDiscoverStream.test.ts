import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/api/client', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '../../src/api/client'
import { useDiscoverStream, type StreamState } from '../../src/hooks/useDiscoverStream'
import type { Item } from '../../src/api/items'

const apiFetchMock = vi.mocked(apiFetch)

const cached = (contextDescription: string): StreamState => ({
  shortlist: [], shortlistPool: [], shortlistSource: 'full',
  relatedOutfits: [], relatedOutfitsPool: [], relatedOutfitsSource: 'jev',
  suggestions: [], contextDescription, retrievalMode: 'generated', phase: 'done', error: null,
})

describe('useDiscoverStream cache scope', () => {
  beforeEach(() => sessionStorage.clear())

  it('restores only its own tab’s cached results', () => {
    sessionStorage.setItem('closet-discover-stream:discover', JSON.stringify(cached('yellow streetwear')))

    const suggest = renderHook(() => useDiscoverStream('suggest'))
    expect(suggest.result.current.contextDescription).toBeNull()
    expect(suggest.result.current.phase).toBe('idle')

    const discover = renderHook(() => useDiscoverStream('discover'))
    expect(discover.result.current.contextDescription).toBe('yellow streetwear')
  })

  it('clear() drops only its own cache', () => {
    sessionStorage.setItem('closet-discover-stream:suggest', JSON.stringify(cached('work, 14°C')))
    sessionStorage.setItem('closet-discover-stream:discover', JSON.stringify(cached('yellow streetwear')))

    const { result } = renderHook(() => useDiscoverStream('suggest'))
    act(() => result.current.clear())

    expect(sessionStorage.getItem('closet-discover-stream:suggest')).toBeNull()
    expect(sessionStorage.getItem('closet-discover-stream:discover')).not.toBeNull()
  })
})

function sseResponse(events: { event: string; data: Record<string, unknown> }[]) {
  const encoder = new TextEncoder()
  const chunks = events.map(e => encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`))
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

function shortlistStream(pool: { id: string }[]) {
  return sseResponse([
    { event: 'shortlist', data: { items: pool, pool, source: 'full', contextDescription: 'test' } },
  ])
}

const mkItems = (n: number, prefix = 'i') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` })) as unknown as Item[]

const ids = (items: Item[] | null) => (items ?? []).map(i => i.id)

async function submitShortlist(result: { current: ReturnType<typeof useDiscoverStream> }, pool: { id: string }[]) {
  apiFetchMock.mockResolvedValueOnce(shortlistStream(pool))
  await act(async () => {
    await result.current.submit('weather', { coords: { lat: 0, lon: 0 } })
  })
}

describe('useDiscoverStream item window (ITEM_WINDOW = 8)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  it('shows the first 8 items of the pool', async () => {
    const pool = mkItems(20)
    const { result } = renderHook(() => useDiscoverStream('suggest'))
    await submitShortlist(result, pool)

    expect(ids(result.current.visibleItems)).toEqual(ids(pool.slice(0, 8)))
    expect(result.current.hasMoreItems).toBe(true)
  })

  it('a pool of 8 or fewer is a single window with hasMoreItems false', async () => {
    const pool = mkItems(8)
    const { result } = renderHook(() => useDiscoverStream('suggest'))
    await submitShortlist(result, pool)

    expect(ids(result.current.visibleItems)).toEqual(ids(pool))
    expect(result.current.hasMoreItems).toBe(false)
  })

  it('reshuffle advances exactly one window and flags the tail', async () => {
    const pool = mkItems(20)
    const { result } = renderHook(() => useDiscoverStream('suggest'))
    await submitShortlist(result, pool)

    act(() => { result.current.reshuffleItems() })
    expect(ids(result.current.visibleItems)).toEqual(ids(pool.slice(8, 16)))
    expect(result.current.hasMoreItems).toBe(true)

    act(() => { result.current.reshuffleItems() })
    expect(ids(result.current.visibleItems)).toEqual(ids(pool.slice(16, 20)))
    expect(result.current.hasMoreItems).toBe(false)
  })

  it('exhausted pool returns excludeIds of every seen item for the re-submit', async () => {
    const pool = mkItems(12)
    const { result } = renderHook(() => useDiscoverStream('suggest'))
    await submitShortlist(result, pool)

    act(() => { result.current.reshuffleItems() })
    let exhausted: ReturnType<typeof result.current.reshuffleItems> | undefined
    act(() => { exhausted = result.current.reshuffleItems() })
    expect(exhausted?.exhausted).toBe(true)
    expect(exhausted?.excludeIds?.items).toEqual(ids(pool))
    // window wrapped back to the start
    expect(ids(result.current.visibleItems)).toEqual(ids(pool.slice(0, 8)))

    // Caller re-submits with the excludeIds (SuggestTab's handleReshuffleItems pattern)
    const freshPool = mkItems(12, 'j')
    apiFetchMock.mockResolvedValueOnce(shortlistStream(freshPool))
    await act(async () => {
      await result.current.submit('weather', { coords: { lat: 0, lon: 0 }, excludeIds: exhausted!.excludeIds })
    })

    const body = apiFetchMock.mock.calls[apiFetchMock.mock.calls.length - 1][1]?.body as string
    expect(body).toContain('"excludeIds"')
    expect(ids(result.current.visibleItems)).toEqual(ids(freshPool.slice(0, 8)))
    expect(result.current.hasMoreItems).toBe(true)
  })

  it('stops requesting re-submits after MAX_EXHAUSTION_RESUBMITS exhaustions', async () => {
    const pool = mkItems(8)
    const { result } = renderHook(() => useDiscoverStream('suggest'))
    await submitShortlist(result, pool)

    for (let i = 0; i < 25; i++) {
      let r: ReturnType<typeof result.current.reshuffleItems> | undefined
      act(() => { r = result.current.reshuffleItems() })
      expect(r?.exhausted).toBe(true)
    }
    let final: ReturnType<typeof result.current.reshuffleItems> | undefined
    act(() => { final = result.current.reshuffleItems() })
    expect(final).toEqual({ exhausted: false })
  })
})
