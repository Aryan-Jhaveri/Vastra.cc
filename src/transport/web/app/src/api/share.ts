import { apiFetch, apiFetchJSON } from './client'

export interface SharePayload {
  id: string
  source: string
  description: string
  imageUris: string[]
  senderHandle: string | null
  senderName: string | null
  createdAt: number
  expiresAt: number | null
  outfit: {
    id: string
    name: string
    occasion: string | null
    coverImageUri: string | null
  } | null
}

export async function createShare(data: {
  source: 'outfit' | 'suggestion' | 'inspiration' | 'manual'
  sourceRef?: string
  description: string
  imageUris?: string[]
  senderHandle?: string
}): Promise<{ id: string; url: string }> {
  return apiFetchJSON('/api/share', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export interface MyShareItem {
  id: string
  source: string
  description: string
  imageUris: string[]
  createdAt: number
  expiresAt: number | null
  openCount: number
  url: string
}

export async function getShare(id: string): Promise<SharePayload> {
  return apiFetchJSON(`/api/share/${id}`)
}

export async function claimShare(id: string, claimToken: string): Promise<{ id: string; redirect: string }> {
  return apiFetchJSON(`/api/share/${id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ claimToken }),
  })
}

export async function fetchMyShares(): Promise<MyShareItem[]> {
  return apiFetchJSON('/api/share')
}

export async function deleteShare(id: string): Promise<void> {
  await apiFetch(`/api/share/${id}`, { method: 'DELETE' })
}
