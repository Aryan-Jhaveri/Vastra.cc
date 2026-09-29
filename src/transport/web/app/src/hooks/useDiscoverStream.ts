import { useState, useCallback, useRef } from 'react'
import { apiFetch } from '../api/client'
import type { OutfitSuggestion, HydratedOutfit } from '../api/outfits'
import type { Item } from '../api/items'
import type { ShopQuery } from '../api/shop'

export interface ReshuffleResult {
  exhausted: boolean
  excludeIds?: { items?: string[]; outfits?: string[] }
}

export type UseDiscoverStreamReturn = StreamState & {
  visibleItems: Item[] | null
  visibleOutfits: HydratedOutfit[] | null
  hasMoreItems: boolean
  hasMoreOutfits: boolean
  submit: (mode: StreamMode, payload?: StreamPayload) => Promise<void>
  clear: () => void
  reshuffleItems: () => ReshuffleResult | undefined
  reshuffleOutfits: () => ReshuffleResult | undefined
}

// Suggest and Discover each mount their own stream, so each gets its own cache.
// A single shared key let one tab restore the other's results on mount.
export type StreamCacheScope = 'suggest' | 'discover'
const cacheKey = (scope: StreamCacheScope) => `closet-discover-stream:${scope}`
const ITEM_WINDOW = 8
const OUTFIT_WINDOW = 4
const MAX_EXHAUSTION_RESUBMITS = 25

export interface StreamState {
  shortlist: Item[] | null
  shortlistPool: Item[] | null
  shortlistSource: string | null
  relatedOutfits: HydratedOutfit[] | null
  relatedOutfitsPool: HydratedOutfit[] | null
  relatedOutfitsSource: string | null
  suggestions: OutfitSuggestion[] | null
  contextDescription: string | null
  /** Related shop row search built server-side from this run's context (#324). */
  shopQuery: ShopQuery | null
  retrievalMode: 'generated' | 'retrieved' | null
  phase: 'idle' | 'shortlisting' | 'generating' | 'done' | 'error'
  error: string | null
}

export type StreamMode = 'prompt' | 'image' | 'shared' | 'weather'

export interface StreamPayload {
  prompt?: string
  imageFile?: File
  shareId?: string
  coords?: { lat: number; lon: number }
  excludeIds?: { items?: string[]; outfits?: string[] }
  occasion?: string
  isRegenerate?: boolean
}

function loadCached(key: string): StreamState | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as StreamState) : null
  } catch {
    return null
  }
}

const emptyState: StreamState = {
  shortlist: null,
  shortlistPool: null,
  shortlistSource: null,
  relatedOutfits: null,
  relatedOutfitsPool: null,
  relatedOutfitsSource: null,
  suggestions: null,
  contextDescription: null,
  shopQuery: null,
  retrievalMode: null,
  phase: 'idle',
  error: null,
}

export function useDiscoverStream(scope: StreamCacheScope) {
  const CACHE_KEY = cacheKey(scope)
  const [state, setState] = useState<StreamState>(() => loadCached(CACHE_KEY) ?? { ...emptyState })
  const [itemWindowStart, setItemWindowStart] = useState(0)
  const [outfitWindowStart, setOutfitWindowStart] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  // Track seen IDs for pool exhaustion
  const seenItemsRef = useRef<Set<string>>(new Set())
  const seenOutfitsRef = useRef<Set<string>>(new Set())
  const reshuffleCountRef = useRef(0)

  const clear = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState({ ...emptyState })
    setItemWindowStart(0)
    setOutfitWindowStart(0)
    seenItemsRef.current = new Set()
    seenOutfitsRef.current = new Set()
    reshuffleCountRef.current = 0
    sessionStorage.removeItem(CACHE_KEY)
  }, [CACHE_KEY])

  const submit = useCallback(async (
    mode: StreamMode,
    payload: StreamPayload = {},
  ) => {
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller

    // Reset windows + seen sets on fresh submit (no excludeIds = fresh search)
    if (!payload.excludeIds) {
      setItemWindowStart(0)
      setOutfitWindowStart(0)
      seenItemsRef.current = new Set()
      seenOutfitsRef.current = new Set()
      reshuffleCountRef.current = 0
    }

    setState(s => ({ ...s, shortlist: null, shortlistPool: null, relatedOutfits: null, relatedOutfitsPool: null, suggestions: null, retrievalMode: null, phase: 'shortlisting', error: null }))

    try {
      let body: FormData | string
      const { coords, excludeIds, imageFile, prompt: promptText, shareId, occasion, isRegenerate } = payload

      if (mode === 'image') {
        const form = new FormData()
        form.set('mode', 'image')
        if (imageFile) form.set('image', imageFile)
        if (coords) { form.set('lat', String(coords.lat)); form.set('lon', String(coords.lon)) }
        if (excludeIds) form.set('excludeIds', JSON.stringify(excludeIds))
        if (occasion) form.set('occasion', occasion)
        if (isRegenerate) form.set('isRegenerate', 'true')
        body = form
      } else {
        const jsonBody: Record<string, unknown> = { mode }
        if (coords) { jsonBody.lat = coords.lat; jsonBody.lon = coords.lon }
        if (excludeIds) jsonBody.excludeIds = excludeIds
        if (occasion) jsonBody.occasion = occasion
        if (isRegenerate) jsonBody.isRegenerate = true
        if (mode === 'prompt') jsonBody.prompt = promptText
        else if (mode === 'shared' && shareId) jsonBody.shareId = shareId
        body = JSON.stringify(jsonBody)
      }

      const res = await apiFetch('/api/discover/stream', {
        method: 'POST',
        body,
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error((err as { error: string }).error)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''

      let shortlistState: Pick<StreamState, 'shortlist' | 'shortlistPool' | 'shortlistSource' | 'contextDescription' | 'shopQuery'> = {
        shortlist: null,
        shortlistPool: null,
        shortlistSource: null,
        contextDescription: null,
        shopQuery: null,
      }

      let relatedOutfitsSnapshot: Pick<StreamState, 'relatedOutfits' | 'relatedOutfitsPool' | 'relatedOutfitsSource'> = {
        relatedOutfits: null,
        relatedOutfitsPool: null,
        relatedOutfitsSource: null,
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const lines = part.split('\n')
          let eventType = ''
          let dataStr = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim()
            else if (line.startsWith('data: ')) dataStr = line.slice(6).trim()
          }

          if (eventType === 'error') {
            const data = JSON.parse(dataStr) as { error: string; code?: string; required?: number; balance?: number }
            if (data.code === 'INSUFFICIENT_TOKENS') {
              // Reuse the global top-up dialog (mounted in App.tsx). The
              // shortlist + related outfits already emitted stay visible —
              // only the AI picks phase is blocked.
              window.dispatchEvent(new CustomEvent('insufficient-tokens', {
                detail: { required: data.required ?? 0, balance: data.balance ?? 0 },
              }))
              throw new Error('Out of tokens — top up to generate AI picks.')
            }
            throw new Error(data.error)
          }

          if (eventType === 'shortlist') {
            const data = JSON.parse(dataStr) as { items: Item[]; pool: Item[]; source: string; contextDescription: string; shop?: ShopQuery }
            shortlistState = {
              shortlist: data.items,
              shortlistPool: data.pool,
              shortlistSource: data.source,
              contextDescription: data.contextDescription,
              shopQuery: data.shop?.query ? data.shop : null,
            }
            // Track seen items
            if (data.pool) {
              for (const item of data.pool) {
                seenItemsRef.current.add(item.id)
              }
            }
            setState(s => ({
              ...s,
              ...shortlistState,
              ...relatedOutfitsSnapshot,
              phase: 'generating',
            }))
          }

          if (eventType === 'related_outfits') {
            const data = JSON.parse(dataStr) as { outfits: HydratedOutfit[]; pool: HydratedOutfit[]; source: string }
            relatedOutfitsSnapshot = {
              relatedOutfits: data.outfits,
              relatedOutfitsPool: data.pool,
              relatedOutfitsSource: data.source,
            }
            if (data.pool) {
              for (const o of data.pool) {
                seenOutfitsRef.current.add(o.id)
              }
            }
            setState(s => ({
              ...s,
              ...relatedOutfitsSnapshot,
            }))
          }

          if (eventType === 'suggestions') {
            const data = JSON.parse(dataStr) as { suggestions: OutfitSuggestion[]; retrievalMode?: 'generated' | 'retrieved' }
            const finalState: StreamState = {
              ...shortlistState,
              ...relatedOutfitsSnapshot,
              suggestions: data.suggestions,
              retrievalMode: data.retrievalMode ?? 'generated',
              phase: 'done',
              error: null,
            }
            setState(finalState)
            try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(finalState)) } catch { /* quota */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setState(s => ({ ...s, phase: 'error', error: String(err) }))
    }
  }, [CACHE_KEY])

  const reshuffleItems = useCallback(() => {
    const pool = state.shortlistPool
    if (!pool || pool.length === 0) return
    const nextStart = itemWindowStart + ITEM_WINDOW
    if (nextStart >= pool.length) {
      if (reshuffleCountRef.current < MAX_EXHAUSTION_RESUBMITS) {
        reshuffleCountRef.current++
        setItemWindowStart(0)
        return { exhausted: true, excludeIds: { items: [...seenItemsRef.current] } }
      }
      setItemWindowStart(0)
      return { exhausted: false }
    }
    setItemWindowStart(nextStart)
    return { exhausted: false }
  }, [state.shortlistPool, itemWindowStart])

  const reshuffleOutfits = useCallback(() => {
    const pool = state.relatedOutfitsPool
    if (!pool || pool.length === 0) return
    const nextStart = outfitWindowStart + OUTFIT_WINDOW
    if (nextStart >= pool.length) {
      if (reshuffleCountRef.current < MAX_EXHAUSTION_RESUBMITS) {
        reshuffleCountRef.current++
        setOutfitWindowStart(0)
        return { exhausted: true, excludeIds: { outfits: [...seenOutfitsRef.current] } }
      }
      setOutfitWindowStart(0)
      return { exhausted: false }
    }
    setOutfitWindowStart(nextStart)
    return { exhausted: false }
  }, [state.relatedOutfitsPool, outfitWindowStart])

  // Computed: current window of items / outfits from pool
  const visibleItems = state.shortlistPool
    ? state.shortlistPool.slice(itemWindowStart, itemWindowStart + ITEM_WINDOW)
    : state.shortlist

  const visibleOutfits = state.relatedOutfitsPool
    ? state.relatedOutfitsPool.slice(outfitWindowStart, outfitWindowStart + OUTFIT_WINDOW)
    : state.relatedOutfits

  const hasMoreItems = state.shortlistPool
    ? itemWindowStart + ITEM_WINDOW < state.shortlistPool.length
    : false

  const hasMoreOutfits = state.relatedOutfitsPool
    ? outfitWindowStart + OUTFIT_WINDOW < state.relatedOutfitsPool.length
    : false

  return {
    ...state,
    visibleItems,
    visibleOutfits,
    hasMoreItems,
    hasMoreOutfits,
    submit,
    clear,
    reshuffleItems,
    reshuffleOutfits,
  }
}
