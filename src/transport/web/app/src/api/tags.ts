import { apiFetchJSON } from './client'

// #372 — the user's created tags / occasions and deleting one everywhere.

export type FacetKind = 'tag' | 'occasion'

export interface FacetUsage {
  value: string
  items: number
  outfits: number
  collections: number
}

export interface FacetDeleteResult {
  items: number
  outfits: number
  collections: number
}

export async function fetchFacets(kind: FacetKind): Promise<FacetUsage[]> {
  const res = await apiFetchJSON<{ values: FacetUsage[] }>(`/api/tags?kind=${kind}`)
  return res.values
}

export function deleteFacets(kind: FacetKind, values: string[]): Promise<FacetDeleteResult> {
  return apiFetchJSON<FacetDeleteResult>('/api/tags/delete', {
    method: 'POST',
    body: JSON.stringify({ kind, values }),
  })
}
