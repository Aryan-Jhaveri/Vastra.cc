import { useEffect, useState } from 'react'

// #332 — relatedEnabled (reported by /api/auth/status: a decision provider is
// configured) gates the "Find related" sections in the detail cards. Fetched
// once per page load; starts false so an unconfigured instance never flashes them.
let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function loadRelatedEnabled(): Promise<boolean> {
  if (!inflight) {
    inflight = fetch('/api/auth/status')
      .then(r => r.json())
      .then((d: { relatedEnabled?: boolean }) => { cached = d.relatedEnabled === true; return cached })
      .catch(() => { inflight = null; return false })
  }
  return inflight
}

export function useRelatedEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    void loadRelatedEnabled().then(v => { if (!cancelled) setEnabled(v) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

/** Test hook — forget the cached flag. */
export function resetRelatedEnabled(): void {
  cached = null
  inflight = null
}
