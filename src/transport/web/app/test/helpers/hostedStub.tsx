import type { ComponentType, ReactNode } from 'react'

// What src/hosted/index exposes in the open-source build (same API as
// oss/stubs/.../hosted/index.tsx): every slot empty, no routes. Shared tests
// mock the hosted index with this, so they pass with or without the hosted UI:
//   vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))
// Hosted UI itself is tested under test/hosted/.

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

export async function fetchTokenBalance(): Promise<number> {
  throw new Error('fetchTokenBalance is hosted-only')
}

export function HostedSignupConsent(_props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return null
}

export const signupConsentRequired = false
