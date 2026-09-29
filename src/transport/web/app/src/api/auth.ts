import { apiFetchJSON } from './client'

export interface MeResponse {
  userId: string
  email: string
  name: string | null
  /** Instance admin: sees Settings › Instance (#315). */
  isAdmin?: boolean
}

export interface InstanceConfigEntry { key: string; set: boolean; value: string | null; secret?: true }
export interface InstanceConfig {
  hostedMode: boolean
  signupsOpen: boolean
  chatEnabled: boolean
  decisions: string | null
  groups: Array<{ title: string; entries: InstanceConfigEntry[] }>
}

/** Admin only: the active instance config, secrets as set/unset (#315). */
export function getInstanceConfig(): Promise<InstanceConfig> {
  return apiFetchJSON<InstanceConfig>('/api/admin/config')
}

export function getMe(): Promise<MeResponse> {
  return apiFetchJSON<MeResponse>('/api/auth/me')
}

export function patchMe(body: { name: string }): Promise<MeResponse> {
  return apiFetchJSON<MeResponse>('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}
