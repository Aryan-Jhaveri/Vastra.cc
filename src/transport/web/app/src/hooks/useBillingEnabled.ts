import { useEffect, useState } from 'react'

// #315 — /api/auth/status reports `billing` (on iff HOSTED_MODE). The wallet
// UI (WalletCard, ActivityTable, InsufficientTokensDialog) is hidden when
// billing is off so a self-hosted instance shows no paywall. Fetched once per
// page load; starts false so a self-host instance never flashes the wallet UI.
let cached: boolean | null = null
let inflight: Promise<boolean> | null = null

function loadBillingEnabled(): Promise<boolean> {
  if (!inflight) {
    inflight = fetch('/api/auth/status')
      .then(r => r.json())
      .then((d: { billing?: boolean }) => { cached = d.billing === true; return cached })
      .catch(() => { inflight = null; return false })
  }
  return inflight
}

export function useBillingEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) return
    let cancelled = false
    void loadBillingEnabled().then(v => { if (!cancelled) setEnabled(v) })
    return () => { cancelled = true }
  }, [])
  return enabled
}

/** Test hook — forget the cached flag. */
export function resetBillingEnabled(): void {
  cached = null
  inflight = null
}
