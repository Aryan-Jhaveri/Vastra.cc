import type { Response } from 'express'
import { InsufficientTokensError } from '../../cost/errors.js'
import { isHostedMode } from '../../hostedMode.js'

export function respondInsufficientTokens(err: unknown, res: Response): boolean {
  // #315 — self-host has no token paywall (no-op billing), so an
  // InsufficientTokensError can never originate there. Short-circuit so the
  // route's catch falls through to the generic error even if a stray
  // InsufficientTokensError ever propagated.
  if (!isHostedMode()) return false
  if (!(err instanceof InsufficientTokensError)) return false
  res.status(402).json({
    error: 'Insufficient tokens',
    code: err.code,
    required: err.required,
    balance: err.balance,
  })
  return true
}
