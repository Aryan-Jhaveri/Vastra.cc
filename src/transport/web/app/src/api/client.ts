import { resetLocalTheme } from '../lib/theme'

// Session auth is cookie-only (#295): the httpOnly `closet-auth` cookie rides
// every same-origin request and no session token is ever stored in web
// storage. Mutations carry the `X-Requested-With` proof header for the
// server's CSRF middleware (cross-site forms can't set custom headers).

// Legacy keys from the pre-#295 build (localStorage/sessionStorage token).
// Removed on boot so upgraded browsers drop any token they still hold.
const LEGACY_AUTH_KEY = 'closet-auth-token'
const LEGACY_REMEMBER_KEY = 'closet-auth-remember'

export function purgeLegacyTokenStorage(): void {
  try {
    localStorage.removeItem(LEGACY_AUTH_KEY)
    localStorage.removeItem(LEGACY_REMEMBER_KEY)
    sessionStorage.removeItem(LEGACY_AUTH_KEY)
  } catch { /* storage unavailable */ }
}

// Use for <img src> instead of bare `/${uri}`. Image requests authenticate via
// the httpOnly `closet-auth` cookie set on every sign-in path — never put the
// session token in the URL, where it leaks into logs, caches and the SW cache.
export function getImageSrc(imageUri: string): string {
  return imageUri.startsWith('/') ? imageUri : `/${imageUri}`
}

export function thumbUri(imageUri: string): string {
  const dot = imageUri.lastIndexOf('.')
  return dot > 0 ? `${imageUri.slice(0, dot)}_thumb${imageUri.slice(dot)}` : `${imageUri}_thumb`
}

// Service-worker caches and sessionStorage hold the signed-in user's wardrobe
// data and are not partitioned by user, so they are dropped whenever the
// identity changes — otherwise the next user on this device can be served the
// previous user's cached responses while offline.
const PRIVATE_CACHES = ['api-cache', 'image-cache']

// Per-account localStorage keys (#375). localStorage outlives the session, so
// without this the next account on this browser inherits them: a pending share
// id (auto-opened in Discover), onboarding/walkthrough flags, the saved
// location. Deliberately NOT listed:
//   - `closet-session-changed`: cross-tab sign-in ping (Login.tsx listens for
//     `storage` events on it). Removing it would fire that event in other tabs
//     and make a signed-out tab try to complete a login.
//   - `closet:swipe-hint-dismissed`: device-level UI hint, not account data.
//   - `closet:nav-width`: device layout; reconciled from server settings.
// Theme keys are owned by lib/theme.ts and cleared by resetLocalTheme().
export const ACCOUNT_LOCAL_STORAGE_KEYS = [
  'closet-pending-share',
  'closet_onboarded',
  'closet_walkedthrough',
  'closet-location',
] as const

export function resetLocalAccountState(): void {
  for (const key of ACCOUNT_LOCAL_STORAGE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
  }
  resetLocalTheme()
}

export function purgePrivateState(): void {
  try { sessionStorage.clear() } catch { /* storage unavailable */ }
  if (typeof caches !== 'undefined') {
    for (const name of PRIVATE_CACHES) caches.delete(name).catch(() => {})
  }
  purgeLegacyTokenStorage()
  resetLocalAccountState()
}

// Clears client-side session state after sign-out or a rejected session.
// There is no stored token anymore — this drops legacy token keys and the
// non-token private caches.
export function clearSessionState(): void {
  purgePrivateState()
}

export interface ApiFetchOptions {
  // Beacon-style callers (analytics, push) set silent=true so a single blocked
  // or failed request doesn't escalate into a global "server unavailable"
  // banner. Ad blockers commonly drop these endpoints.
  silent?: boolean
}

export async function apiFetch(path: string, init: RequestInit = {}, opts: ApiFetchOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers)

  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json')
  }

  // CSRF proof for cookie-only mutations; GETs pass the server's CSRF
  // middleware without it, but sending it uniformly keeps the shape constant.
  headers.set('X-Requested-With', 'vastra')

  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch (err) {
    if (err instanceof TypeError && !opts.silent) {
      window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: 0 } }))
    }
    throw err
  }

  if (!opts.silent && (res.status === 502 || res.status === 503 || res.status === 504)) {
    window.dispatchEvent(new CustomEvent('server-unavailable', { detail: { status: res.status } }))
  }

  // Session rejected mid-flight: drop private state and reload. Pre-auth
  // screens (Login, AuthVerify, ShareLanding) use bare fetch, not apiFetch,
  // so this only fires once a session was in play.
  if (res.status === 401) {
    clearSessionState()
    window.location.href = '/'
  }

  return res
}

export class InsufficientTokensError extends Error {
  readonly code = 'INSUFFICIENT_TOKENS' as const

  constructor(
    readonly required: number,
    readonly balance: number,
  ) {
    super(`Insufficient tokens: need ${required}, have ${balance}`)
    this.name = 'InsufficientTokensError'
  }
}

async function readJsonSafe<T>(res: Response): Promise<T | null> {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) as T } catch { return null }
}

export async function apiFetchJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init)
  if (!res.ok) {
    if (res.status === 402) {
      const body = await readJsonSafe<{ code?: string; required?: number; balance?: number; error?: string }>(res.clone())
      if (body?.code === 'INSUFFICIENT_TOKENS') {
        window.dispatchEvent(new CustomEvent('insufficient-tokens', {
          detail: { required: body.required ?? 0, balance: body.balance ?? 0 },
        }))
        throw new InsufficientTokensError(body.required ?? 0, body.balance ?? 0)
      }
    }
    const err = await readJsonSafe<{ error: string }>(res) ?? { error: res.statusText }
    throw new Error(err.error)
  }
  const body = await readJsonSafe<T>(res)
  if (body === null) throw new Error(`Empty response from ${path}`)
  return body
}