import { apiFetchJSON } from './client'

interface OccasionsResponse {
  presets: string[]
  derived: string[]
  hidden: string[]
}

export async function getOccasions(): Promise<OccasionsResponse> {
  return apiFetchJSON('/api/suggest/occasions')
}

export async function hideOccasion(value: string): Promise<void> {
  await apiFetchJSON('/api/suggest/occasions/hide', {
    method: 'POST',
    body: JSON.stringify({ value }),
  })
}