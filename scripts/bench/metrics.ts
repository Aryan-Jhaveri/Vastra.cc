// #296 Phase 0 — pure helpers for scripts/bench-models.ts, kept apart so
// they're unit-tested (test/scripts/benchMetrics.test.ts).

export interface LatencySummary { n: number; p50: number; p95: number; mean: number; max: number }

/** Nearest-rank percentile of `values` (0 < p ≤ 100). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function summarize(ms: number[]): LatencySummary {
  if (!ms.length) return { n: 0, p50: NaN, p95: NaN, mean: NaN, max: NaN }
  return {
    n: ms.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    mean: ms.reduce((a, b) => a + b, 0) / ms.length,
    max: Math.max(...ms),
  }
}

/** Ranks (1 = highest score), ties get their average rank. */
function ranks(scores: number[]): number[] {
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s)
  const out = new Array<number>(scores.length)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1].s === order[i].s) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[order[k].i] = avg
    i = j + 1
  }
  return out
}

/** Spearman rank correlation over the ids both score maps share. NaN if < 2. */
export function spearman(a: Record<string, number>, b: Record<string, number>): number {
  const ids = Object.keys(a).filter(id => id in b)
  if (ids.length < 2) return NaN
  const ra = ranks(ids.map(id => a[id]))
  const rb = ranks(ids.map(id => b[id]))
  const mean = (ids.length + 1) / 2
  let num = 0, da = 0, db = 0
  for (let i = 0; i < ids.length; i++) {
    num += (ra[i] - mean) * (rb[i] - mean)
    da += (ra[i] - mean) ** 2
    db += (rb[i] - mean) ** 2
  }
  return da === 0 || db === 0 ? NaN : num / Math.sqrt(da * db)
}

export function topK(scores: Record<string, number>, k: number): string[] {
  return Object.entries(scores).sort((x, y) => y[1] - x[1]).slice(0, k).map(([id]) => id)
}

/** Share of `a`'s top-k that is also in `b`'s top-k. */
export function topKOverlap(a: Record<string, number>, b: Record<string, number>, k: number): number {
  const ta = topK(a, k)
  if (!ta.length) return NaN
  const tb = new Set(topK(b, k))
  return ta.filter(id => tb.has(id)).length / ta.length
}

export function meanAbsDiff(a: Record<string, number>, b: Record<string, number>): number {
  const ids = Object.keys(a).filter(id => id in b)
  return ids.length ? ids.reduce((s, id) => s + Math.abs(a[id] - b[id]), 0) / ids.length : NaN
}

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (!relevant.size) return NaN
  return ranked.slice(0, k).filter(id => relevant.has(id)).length / Math.min(k, relevant.size)
}

export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  const i = ranked.findIndex(id => relevant.has(id))
  return i < 0 ? 0 : 1 / (i + 1)
}

export function mean(values: number[]): number {
  const ok = values.filter(v => Number.isFinite(v))
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN
}

export interface GpuSample { index: number; usedMb: number; totalMb: number; utilPct: number }

/** One line of `nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`. */
export function parseNvidiaSmiLine(line: string): GpuSample | null {
  const parts = line.split(',').map(p => Number(p.trim()))
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null
  const [index, usedMb, totalMb, utilPct] = parts
  return { index, usedMb, totalMb, utilPct }
}

// ─── Fixture formats ─────────────────────────────────────────────────────────

/** Decisions agreement fixture: TypeSafe requests, as Vastra sends them. */
export interface DecisionsFixture {
  version: 1
  cases: Array<{ id: string; state: unknown; questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }> }>
}

/** Noul answers per case, from one provider (the saved baseline, or a live run). */
export interface DecisionsAnswers {
  version: 1
  provider: string
  model: string
  cases: Record<string, Record<string, number>>
}

/** Retrieval fixture: docs with text and/or an image, queries with relevant doc ids. */
export interface RecallFixture {
  version: 1
  docs: Array<{ id: string; text?: string; image?: string }>
  queries: Array<{ id: string; kind: string; text: string; relevant: string[] }>
}

function fail(what: string): never {
  throw new Error(`invalid fixture: ${what}`)
}

export function validateDecisionsFixture(json: unknown): DecisionsFixture {
  const f = json as DecisionsFixture
  if (f?.version !== 1 || !Array.isArray(f.cases)) fail('expected { version: 1, cases: [...] }')
  for (const c of f.cases) {
    if (typeof c?.id !== 'string' || !c.questions || typeof c.questions !== 'object') fail('each case needs id + questions')
    if (!Object.keys(c.questions).length) fail(`case ${c.id} has no questions`)
  }
  return f
}

export function validateRecallFixture(json: unknown): RecallFixture {
  const f = json as RecallFixture
  if (f?.version !== 1 || !Array.isArray(f.docs) || !Array.isArray(f.queries)) fail('expected { version: 1, docs, queries }')
  const ids = new Set(f.docs.map(d => d.id))
  for (const q of f.queries) {
    if (typeof q?.text !== 'string' || !Array.isArray(q.relevant)) fail('each query needs text + relevant[]')
    for (const r of q.relevant) if (!ids.has(r)) fail(`query ${q.id} names unknown doc ${r}`)
  }
  return f
}
