import { isHostedMode } from '../hostedMode.js'

// #315 — whether sign-in may create a brand-new account (magic link, Google).
//
// Self-host defaults to closed: a fresh instance on a public URL (a Render
// deploy) must not let a stranger make an account. The first admin comes from
// `admin.mjs create-admin`; a household instance opts in with
// ALLOW_SIGNUPS=true (`make setup` asks "Just me or Household"). vastra.cc
// stays open unless explicitly closed.
export function signupsOpen(): boolean {
  const raw = process.env.ALLOW_SIGNUPS?.trim().toLowerCase()
  if (raw === 'true') return true
  if (raw === 'false') return false
  return isHostedMode()
}
