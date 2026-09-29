import { useState, useEffect, useCallback } from 'react'
import { fetchItems } from '../api/items'
import type { ItemsPage } from '../api/items'

interface UseItemsOptions {
  categories?: string[]
  color?: string
  season?: string
  occasion?: string
  brand?: string
  tags?: string[]
  page?: number
  limit?: number
}

export function useItems(opts: UseItemsOptions = {}) {
  const [data, setData] = useState<ItemsPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const tagsKey = opts.tags?.join(',') ?? ''
  const categoriesKey = opts.categories?.join(',') ?? ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchItems(opts)
      setData(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriesKey, opts.color, opts.season, opts.occasion, opts.brand, opts.page, opts.limit, tagsKey])

  useEffect(() => {
    void load()
  }, [load])

  return { items: data?.items ?? [], total: data?.total ?? 0, loading, error, refetch: load }
}
