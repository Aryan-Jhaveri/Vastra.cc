import { useState, useEffect, useCallback } from 'react'
import { fetchOutfitsHydrated } from '../api/outfits'
import type { HydratedOutfit } from '../api/outfits'

export function useSavedOutfits() {
  const [outfits, setOutfits] = useState<HydratedOutfit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchOutfitsHydrated()
      setOutfits(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { outfits, loading, error, refetch: load }
}
