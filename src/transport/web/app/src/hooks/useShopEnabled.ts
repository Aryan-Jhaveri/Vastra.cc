import { useEffect, useState } from 'react'

// #324 — SHOP_ROW_ENABLED (reported by /api/auth/status) gates the Related shop
// row, the ♡ Liked items entry points and "Shop for". Fetched once per page
// load; starts false so a disabled instance never flashes the shop UI.
let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function loadShopEnabled(): Promise<boolean> {
  if (!inflight) {
    inflight = fetch('/api/auth/status')
      .then(r => r.json())
      .then((d: { shopEnabled?: boolean }) => { cached = d.shopEnabled === true; return cached })
      .catch(() => { inflight = null; return false })
  }
  return inflight
}

export function useShopEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    void loadShopEnabled().then(v => { if (!cancelled) setEnabled(v) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

/** Test hook — forget the cached flag. */
export function resetShopEnabled(): void {
  cached = null
  inflight = null
}
