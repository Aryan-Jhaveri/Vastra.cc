import { apiFetch, apiFetchJSON } from './client'

export type ApiTokenScope = 'read' | 'write' | 'ai'

export interface ApiTokenView {
  id: string
  name: string
  prefix: string
  scopes: ApiTokenScope[]
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

/** One-time plaintext returned only at creation. */
export interface CreatedApiToken {
  token: ApiTokenView
  plaintext: string
}

export interface AuthStatus {
  hasPassword: boolean
  adminFallback: boolean
  google: boolean
  tokensEnabled: boolean
  // #328 — the Ask tab. Off on vastra.cc until #248; on for self-host with a text model.
  chatEnabled?: boolean
  // #315 — hostedMode/billing gate the wallet UI. billing is on iff hosted.
  hostedMode: boolean
  billing: boolean
}

export function getAuthStatus(): Promise<AuthStatus> {
  return apiFetchJSON<AuthStatus>('/api/auth/status', { method: 'GET' })
}

export function listTokens(): Promise<ApiTokenView[]> {
  return apiFetchJSON<ApiTokenView[]>('/api/tokens')
}

export function createToken(name: string, scopes: ApiTokenScope[]): Promise<CreatedApiToken> {
  return apiFetchJSON<CreatedApiToken>('/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name, scopes }),
  })
}

export function revokeToken(id: string): Promise<void> {
  return apiFetch(`/api/tokens/${id}`, { method: 'DELETE' }).then((res) => {
    if (!res.ok) throw new Error('Failed to revoke token')
  })
}
