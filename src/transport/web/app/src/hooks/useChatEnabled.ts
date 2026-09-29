import { useEffect, useState } from 'react'

// #328 — `chatEnabled` (reported by /api/auth/status) gates the Ask tab. The
// server also 404s /api/chat/* when it's off, so this only hides the UI.
// Fetched once per page load; starts false so a disabled instance never
// flashes the tab.
let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function loadChatEnabled(): Promise<boolean> {
  if (!inflight) {
    inflight = fetch('/api/auth/status')
      .then(r => r.json())
      .then((d: { chatEnabled?: boolean }) => { cached = d.chatEnabled === true; return cached })
      .catch(() => { inflight = null; return false })
  }
  return inflight
}

export function useChatEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    void loadChatEnabled().then(v => { if (!cancelled) setEnabled(v) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

/** Test hook — forget the cached flag. */
export function resetChatEnabled(): void {
  cached = null
  inflight = null
}
