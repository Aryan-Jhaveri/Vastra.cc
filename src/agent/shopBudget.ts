// ─── Shop call budget for agent tools (#341) ───────────────────────────────────
//
// A model loop must not hammer the Shopify catalog. Two limits, in memory:
//   - at most SHOP_SEARCHES_PER_TURN search_shop calls per turn (keyed on the
//     turn id; MCP calls carry none and rely on the per-minute limit), and
//   - at most SHOP_CALLS_PER_MINUTE shop tool calls per user, the same budget
//     as the /api/shop/related route limiter (a separate counter: that one is
//     Express middleware keyed on the request).
// Slots are taken synchronously before any await, so parallel tool calls in
// one step can't race past the cap.

export const SHOP_SEARCHES_PER_TURN = 2
export const SHOP_CALLS_PER_MINUTE = 10
const MINUTE_MS = 60_000
const TURN_TTL_MS = 10 * MINUTE_MS

const turns = new Map<string, { n: number; at: number }>()
const users = new Map<string, number[]>()

/** Takes a slot, or returns the error message the model should see. */
export function takeShopCall(userId: string, opts: { turnId?: string; search: boolean }): string | null {
  const now = Date.now()
  for (const [id, t] of turns) if (now - t.at > TURN_TTL_MS) turns.delete(id)

  const recent = (users.get(userId) ?? []).filter(at => now - at < MINUTE_MS)
  if (recent.length >= SHOP_CALLS_PER_MINUTE) {
    users.set(userId, recent)
    return 'Shop limit reached (too many shop searches this minute). Work with the products already shown.'
  }
  if (opts.search && opts.turnId) {
    const turn = turns.get(opts.turnId) ?? { n: 0, at: now }
    if (turn.n >= SHOP_SEARCHES_PER_TURN) {
      return `At most ${SHOP_SEARCHES_PER_TURN} shop searches per message. Work with the products already shown.`
    }
    turns.set(opts.turnId, { n: turn.n + 1, at: turn.at })
  }
  recent.push(now)
  users.set(userId, recent)
  return null
}

/** Tests only. */
export function resetShopBudget(): void {
  turns.clear()
  users.clear()
}
