import { apiFetch, apiFetchJSON } from './client'

export interface UserPhoto {
  id: string
  imageUri: string
  label: string | null
  isPrimary: number
  createdAt: number
}

export async function fetchUserPhotos(): Promise<UserPhoto[]> {
  return apiFetchJSON('/api/user-photos')
}

export async function uploadUserPhoto(file: File, label?: string): Promise<UserPhoto> {
  const fd = new FormData()
  fd.append('image', file)
  if (label) fd.append('label', label)
  return apiFetchJSON('/api/user-photos', { method: 'POST', body: fd })
}

export async function setPrimaryPhoto(id: string): Promise<UserPhoto> {
  return apiFetchJSON(`/api/user-photos/${id}/primary`, { method: 'PATCH' })
}

export async function deleteUserPhoto(id: string): Promise<void> {
  await apiFetch(`/api/user-photos/${id}`, { method: 'DELETE' })
}
