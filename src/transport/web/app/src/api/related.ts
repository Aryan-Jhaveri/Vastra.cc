import { apiFetch } from './client'
import type { Item } from './items'
import type { HydratedOutfit } from './outfits'

// #332 — "Find related" on the Item / Outfit / Collection detail cards.
// Uses apiFetch in silent mode: a failed find is a 502 and "no decision
// provider" a 503, which must not raise the global server-down banner.

export type RelatedKind = 'item' | 'outfit' | 'collection'

export interface RelatedQuota { used: number; limit: number; resetsAt: number | null }

export interface RelatedResult {
  kind: RelatedKind
  status: 'success' | 'empty'
  foundAt: number
  scores: Record<string, number>
  items?: Item[]
  outfits?: HydratedOutfit[]
}

export type RelatedFindOutcome =
  | { kind: 'result'; result: RelatedResult }
  | { kind: 'capped'; resetsAt: number | null }
  | { kind: 'busy' }
  | { kind: 'error' }

const base = (kind: RelatedKind, id: string) =>
  `/api/${kind === 'item' ? 'items' : kind === 'outfit' ? 'outfits' : 'collections'}/${encodeURIComponent(id)}/related`

export async function findRelated(kind: RelatedKind, id: string): Promise<RelatedFindOutcome> {
  let res: Response
  try {
    res = await apiFetch(base(kind, id), { method: 'POST' }, { silent: true })
  } catch {
    return { kind: 'error' }
  }
  if (res.ok) return { kind: 'result', result: await res.json() as RelatedResult }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as { resetsAt?: number | null }
    return { kind: 'capped', resetsAt: body.resetsAt ?? null }
  }
  if (res.status === 409) return { kind: 'busy' }
  return { kind: 'error' }
}

/** The saved last result, or null when there's none or it's out of date. Free. */
export async function fetchSavedRelated(kind: RelatedKind, id: string): Promise<RelatedResult | null> {
  try {
    const res = await apiFetch(base(kind, id), {}, { silent: true })
    if (!res.ok) return null
    const body = await res.json() as RelatedResult & { found: boolean }
    return body.found ? body : null
  } catch {
    return null
  }
}
