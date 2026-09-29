import { useState, useCallback } from 'react'
import { findOutfitsFromPrompt, findOutfitsFromImage, findOutfitsFromShare } from '../api/discover'
import type { DiscoverResult } from '../api/discover'

const CACHE_KEY = 'closet-discover'

function loadCached(): DiscoverResult | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as DiscoverResult) : null
  } catch {
    return null
  }
}

export function useDiscover() {
  const [result, setResult] = useState<DiscoverResult | null>(loadCached)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async (
    mode: 'prompt' | 'image' | 'shared',
    payload: { prompt?: string; imageFile?: File; shareId?: string },
    coords?: { lat: number; lon: number },
  ) => {
    setLoading(true)
    setError(null)
    try {
      let res: DiscoverResult
      if (mode === 'prompt') {
        if (!payload.prompt) throw new Error('Prompt is required')
        res = await findOutfitsFromPrompt(payload.prompt, coords?.lat, coords?.lon)
      } else if (mode === 'image') {
        if (!payload.imageFile) throw new Error('Image is required')
        res = await findOutfitsFromImage(payload.imageFile, coords?.lat, coords?.lon)
      } else {
        if (!payload.shareId) throw new Error('Share ID is required')
        res = await findOutfitsFromShare(payload.shareId, coords?.lat, coords?.lon)
      }
      setResult(res)
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(res)) } catch { /* quota */ }
      return res
    } catch (err) {
      setError(String(err))
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const clear = useCallback(() => {
    setResult(null)
    setError(null)
    sessionStorage.removeItem(CACHE_KEY)
  }, [])

  return { result, loading, error, submit, clear }
}
