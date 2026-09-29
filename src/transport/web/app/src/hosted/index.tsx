import type { ComponentType, ReactNode } from 'react'

// Open-source build: the hosted (vastra.cc) UI — wallet, billing, admin
// metrics, vastra.cc's legal pages — isn't part of this repository. Every slot
// renders nothing and no routes are added.

export function HostedBillingSection() {
  return null
}

export function HostedLegalLinks() {
  return null
}

export function hostedPublicPage(_pathname: string): ReactNode | null {
  return null
}

export const hostedRoutes: ReadonlyArray<{ path: string; Component: ComponentType }> = []

export function HostedGlobalUI() {
  return null
}

/** Never called here: billing is off (useBillingEnabled) in a self-hosted build. */
export async function fetchTokenBalance(): Promise<number> {
  throw new Error('Token balances are not part of this build')
}

export function HostedSignupConsent(_props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return null
}

export const signupConsentRequired = false
