// A paid action finished: any balance UI should refetch. Nothing listens when
// billing is off (self-host), so dispatching is always safe.
export const WALLET_REFRESH_EVENT = 'wallet-refresh'

export function requestWalletRefresh(): void {
  window.dispatchEvent(new CustomEvent(WALLET_REFRESH_EVENT))
}
