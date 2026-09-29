import { useState, useEffect, useCallback } from 'react'
import { fetchCollectionsHydrated } from '../api/collections'
import type { HydratedCollection } from '../api/collections'

export function useCollections() {
  const [collections, setCollections] = useState<HydratedCollection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchCollectionsHydrated()
      setCollections(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { collections, loading, error, refetch: load }
}
