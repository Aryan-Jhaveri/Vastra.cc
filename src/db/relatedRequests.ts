import { nanoid } from 'nanoid'
import { getSqlite } from './client.js'
import { requireUserId } from './queries.js'

// #332 / #279 — the "Find related" request log and its per-user cap.
//
// Every tap is logged, even though finds are free. The cap is a rolling 24 h
// window (no server-local-midnight problem, #213) that counts rows with
// counts_toward_cap = 1. A find starts as a 'pending' row that already holds
// its slot, taken inside BEGIN IMMEDIATE, so parallel taps can't exceed the
// cap. Only one find per user can be pending at a time.

export type RelatedKind = 'item' | 'outfit' | 'collection'
/** Kinds that count toward the Find related cap; 'item_shop' is ItemDetail's shop row. */
export type RelatedLogKind = RelatedKind | 'item_shop'
export type RelatedStatus = 'pending' | 'success' | 'empty' | 'error' | 'capped'

export const RELATED_WINDOW_MS = 24 * 60 * 60 * 1000
/** A pending row older than this is treated as a crashed find and ignored. */
export const RELATED_IN_FLIGHT_MS = 2 * 60 * 1000

export function relatedDailyLimit(): number {
  const n = Number(process.env.RELATED_DAILY_LIMIT)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100
}

export interface RelatedQuota { used: number; limit: number; resetsAt: number | null }

export type RelatedClaim =
  | { kind: 'claimed'; requestId: string; quota: RelatedQuota }
  | { kind: 'capped'; quota: RelatedQuota }
  | { kind: 'busy' }

function quotaAt(userId: string, now: number): RelatedQuota {
  const row = getSqlite().prepare(`SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM related_requests
    WHERE user_id = ? AND counts_toward_cap = 1 AND created_at > ?
      AND NOT (status = 'pending' AND created_at <= ?)`)
    .get(userId, now - RELATED_WINDOW_MS, now - RELATED_IN_FLIGHT_MS) as { used: number; oldest: number | null }
  const limit = relatedDailyLimit()
  return { used: row.used, limit, resetsAt: row.used >= limit && row.oldest != null ? row.oldest + RELATED_WINDOW_MS : null }
}

export function relatedQuota(userId: string, now = Date.now()): RelatedQuota {
  requireUserId(userId)
  return quotaAt(userId, now)
}

export function claimRelated(userId: string, kind: RelatedLogKind, targetId: string, now = Date.now()): RelatedClaim {
  requireUserId(userId)
  const sqlite = getSqlite()
  return sqlite.transaction((): RelatedClaim => {
    const inFlight = sqlite.prepare(`SELECT 1 FROM related_requests
      WHERE user_id = ? AND status = 'pending' AND created_at > ? LIMIT 1`)
      .get(userId, now - RELATED_IN_FLIGHT_MS)
    if (inFlight) return { kind: 'busy' }
    const quota = quotaAt(userId, now)
    const insert = sqlite.prepare(`INSERT INTO related_requests (id, user_id, kind, target_id, status, counts_toward_cap, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    if (quota.used >= quota.limit) {
      insert.run(nanoid(), userId, kind, targetId, 'capped', 0, now)
      return { kind: 'capped', quota }
    }
    const requestId = nanoid()
    insert.run(requestId, userId, kind, targetId, 'pending', 1, now)
    return { kind: 'claimed', requestId, quota: { ...quota, used: quota.used + 1 } }
  }).immediate()
}

export interface RelatedHit { id: string; score: number }

export function finishRelated(userId: string, requestId: string, outcome: {
  status: 'success' | 'empty' | 'error'
  candidateCount?: number
  result?: RelatedHit[]
  fingerprint?: string
  batchCount?: number
  latencyMs?: number
}): void {
  requireUserId(userId)
  const sqlite = getSqlite()
  // Cost of the find = the decision batches recorded under run_id = requestId.
  const cost = sqlite.prepare('SELECT COALESCE(SUM(wholesale_cost_cents_x100), 0) AS total FROM ai_calls WHERE user_id = ? AND run_id = ?')
    .get(userId, requestId) as { total: number }
  sqlite.prepare(`UPDATE related_requests SET status = ?, counts_toward_cap = ?, candidate_count = ?, result = ?,
      fingerprint = ?, batch_count = ?, latency_ms = ?, cost_x100 = ?
    WHERE id = ? AND user_id = ? AND status = 'pending'`)
    .run(
      outcome.status,
      outcome.status === 'error' ? 0 : 1,
      outcome.candidateCount ?? null,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.fingerprint ?? null,
      outcome.batchCount ?? null,
      outcome.latencyMs ?? null,
      cost.total,
      requestId, userId,
    )
}

/** The latest completed find for this target, for the "previous result" state. */
export function lastRelated(userId: string, kind: RelatedKind, targetId: string):
  { status: 'success' | 'empty'; result: RelatedHit[]; fingerprint: string | null; createdAt: number } | null {
  requireUserId(userId)
  const row = getSqlite().prepare(`SELECT status, result, fingerprint, created_at AS createdAt FROM related_requests
    WHERE user_id = ? AND kind = ? AND target_id = ? AND status IN ('success', 'empty')
    ORDER BY created_at DESC LIMIT 1`)
    .get(userId, kind, targetId) as { status: 'success' | 'empty'; result: string | null; fingerprint: string | null; createdAt: number } | undefined
  if (!row) return null
  let result: RelatedHit[] = []
  try { result = row.result ? JSON.parse(row.result) as RelatedHit[] : [] } catch { /* corrupt: treat as empty */ }
  return { status: row.status, result, fingerprint: row.fingerprint, createdAt: row.createdAt }
}
