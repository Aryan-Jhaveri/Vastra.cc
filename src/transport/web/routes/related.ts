import type { Request, Response } from 'express'
import { getItem, getOutfitWithItems } from '../../../db/queries.js'
import { relatedPlan, RelatedNotFoundError, runRelatedFind } from '../../../ai/related.js'
import {
  lastRelated, relatedQuota,
  type RelatedHit, type RelatedKind, type RelatedQuota,
} from '../../../db/relatedRequests.js'

// #332 / #279 — "Find related" in the Item / Outfit / Collection detail cards.
// Mounted in server.ts behind requireSession (+ CSRF and a burst limiter on
// POST). Every target loads by (id, userId): another user's id is a 404.
//
//   POST /api/{items|outfits|collections}/:id/related  run a find (uses quota)
//   GET  /api/{items|outfits|collections}/:id/related  the saved last result,
//        only while nothing it depends on has changed (free, no model call)
//   GET  /api/related/quota                            { used, limit, resetsAt }

function hydrate(kind: RelatedKind, hits: RelatedHit[], userId: string) {
  const scores = Object.fromEntries(hits.map(h => [h.id, h.score]))
  if (kind === 'item') {
    const items = hits.map(h => getItem(h.id, userId)).filter(i => i != null)
    return { scores, items }
  }
  const outfits = hits.map(h => getOutfitWithItems(h.id, userId)).filter(o => o != null)
  return { scores, outfits }
}

function payload(kind: RelatedKind, status: 'success' | 'empty', hits: RelatedHit[], foundAt: number, userId: string, quota?: RelatedQuota) {
  return { kind, status, foundAt, ...hydrate(kind, hits, userId), ...(quota ? { quota } : {}) }
}

export function findRelated(kind: RelatedKind) {
  return async (req: Request, res: Response) => {
    const userId = req.userId!
    let outcome
    try {
      outcome = await runRelatedFind(kind, String(req.params.id), userId)
    } catch (err) {
      if (err instanceof RelatedNotFoundError) return res.status(404).json({ error: 'Not found' })
      throw err
    }
    switch (outcome.status) {
      case 'unavailable': return res.status(503).json({ error: 'related_unavailable' })
      case 'busy': return res.status(409).json({ error: 'related_in_progress' })
      case 'capped':
        return res.status(429).json({ error: 'related_daily_limit', resetsAt: outcome.quota.resetsAt, quota: outcome.quota })
      case 'error': return res.status(502).json({ error: 'related_failed', quota: outcome.quota })
      default: return res.json(payload(kind, outcome.status, outcome.hits, outcome.foundAt, userId, outcome.quota))
    }
  }
}

export function lastRelatedResult(kind: RelatedKind) {
  return (req: Request, res: Response) => {
    const userId = req.userId!
    let plan
    try {
      plan = relatedPlan(kind, String(req.params.id), userId)
    } catch (err) {
      if (err instanceof RelatedNotFoundError) return res.status(404).json({ error: 'Not found' })
      throw err
    }
    const last = lastRelated(userId, kind, String(req.params.id))
    // Stale once the anchor or any candidate changed: the user finds again.
    if (!last || last.fingerprint !== plan.fingerprint) return res.json({ kind, found: false })
    res.json({ found: true, ...payload(kind, last.status, last.result, last.createdAt, userId) })
  }
}

export function relatedQuotaHandler(req: Request, res: Response) {
  res.json(relatedQuota(req.userId!))
}
