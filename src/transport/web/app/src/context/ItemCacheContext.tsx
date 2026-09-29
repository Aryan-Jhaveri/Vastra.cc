import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { fetchItems } from '../api/items'
import type { Item } from '../api/items'

interface ItemCacheState {
  items: Item[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}

const ItemCacheContext = createContext<ItemCacheState | null>(null)

const CACHE_TTL = 60_000

export function ItemCacheProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastFetchRef = useRef(0)

  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetchRef.current < CACHE_TTL && items.length > 0) return
    setLoading(true)
    setError(null)
    try {
      const result = await fetchItems({ limit: 1000 })
      setItems(result.items)
      lastFetchRef.current = Date.now()
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [items.length])

  useEffect(() => { void load() }, [])

  return (
    <ItemCacheContext.Provider value={{ items, loading, error, refetch: () => load(true) }}>
      {children}
    </ItemCacheContext.Provider>
  )
}

export function useItemCache(): ItemCacheState {
  const ctx = useContext(ItemCacheContext)
  if (!ctx) throw new Error('useItemCache must be used within ItemCacheProvider')
  return ctx
}
