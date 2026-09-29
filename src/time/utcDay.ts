// #213 — allowance windows (free reshuffles, free chat turns, OCR scans) reset
// at UTC midnight / the 1st of the month UTC, for every user. Server-local
// time made the reset hour depend on where the server runs, and let a user
// straddle two "days". UTC is simple, DST-free and the same everywhere.

/** Start of the UTC day containing `now`, in ms. */
export function startOfUtcDayMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Start of the UTC month containing `now`, in ms. */
export function startOfUtcMonthMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** Start of the next UTC month after `now`, in ms. */
export function startOfNextUtcMonthMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
