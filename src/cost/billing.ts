// #315 — Billing seam. The wallet (token balance + spend/refund ledger) is the
// hosted (SaaS) implementation. A self-hosted install has no paywall, so it
// uses a no-op that never reserves or debits but still records ai_calls rows
// for observability. Call sites go through `getBilling()` (src/hostedHooks.ts)
// so the mode is decided in one place; nothing imports the wallet directly to
// charge a call.
//
// ai_calls (per-call cost/token observability) is NOT billing — it is written
// in both modes. Only the wallet (userWallets + walletLedger) is hosted-only.

import { insertAiCall, type AiCallInsert } from '../ai/aiCalls.js'

/**
 * Reservation handle returned by `canSpend`. The hosted impl returns a ledger
 * id to settle/refund against; the no-op returns `null` (nothing to settle).
 */
export type ReservationId = string | null

export interface Billing {
  /** Current token balance. Infinity when billing is off (no paywall). */
  balance(userId: string): number
  /**
   * Reserve `tokens` for an upcoming call. Hosted: checks the wallet and
   * throws `InsufficientTokensError` if the balance is too low, returning a
   * ledger id. No-op: returns `null` (self-host never gates a call on tokens).
   * Only called with a positive token count; free tasks skip it entirely.
   */
  canSpend(userId: string, tokens: number, metadata?: Record<string, unknown>): ReservationId
  /**
   * Settle a successful call: persist the ai_calls row and, when a reservation
   * exists, link it to the wallet ledger. No-op: just records the ai_calls row.
   */
  debit(userId: string, callRow: AiCallInsert, reservationId: ReservationId): void
  /**
   * Refund a reservation on failure. No-op when `reservationId` is null
   * (nothing was reserved). Always a no-op in self-host.
   */
  refund(userId: string, tokens: number, reservationId: ReservationId, metadata?: Record<string, unknown>): void
}

export const noopBilling: Billing = {
  balance() {
    return Number.POSITIVE_INFINITY
  },
  canSpend() {
    return null
  },
  debit(_userId, callRow) {
    insertAiCall(callRow)
  },
  refund() {
    /* self-host has no wallet to refund */
  },
}

