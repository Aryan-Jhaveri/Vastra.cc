import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from './db/schema.js'
import { noopBilling, type Billing } from './cost/billing.js'
import { OpenRouterKeyMissingError } from './cost/errors.js'
import { isHostedMode } from './hostedMode.js'
import type { JobType } from './jobs/registry.js'

// #358 — the seam between shared code and the hosted (vastra.cc) extras.
// Shared code calls these hooks; the defaults are the self-host behaviour.
// `src/hosted/index.ts` registers the hosted implementations at boot, and the
// open-source export replaces that module with a stub that registers nothing.
// The hosted set only applies while HOSTED_MODE is on, so flipping the flag
// (as tests do) behaves exactly like the old call-time isHostedMode() checks.

export type HookTx = BetterSQLite3Database<typeof schema>

export interface HostedHooks {
  billing: Billing
  /** The OpenRouter key for a call made on behalf of `userId`. Throws OpenRouterKeyMissingError. */
  resolveOpenRouterKey(userId: string): string
  /** Runs inside the createUser transaction; a throw rolls the signup back. */
  onUserCreated(tx: HookTx, userId: string): void
  /** After a user verifies their email and signs in for the first time. Fire-and-forget. */
  onUserVerified(userId: string): void
  /** Before an account is deleted. A throw aborts the deletion (fail-closed). */
  beforeAccountDelete(userId: string): Promise<void>
  jobTypes: JobType<any>[]
  /** Run once at boot. Log problems; don't throw. */
  bootChecks: Array<() => void>
}

export const SELF_HOST_HOOKS: Readonly<HostedHooks> = Object.freeze({
  billing: noopBilling,
  resolveOpenRouterKey(userId: string): string {
    const operatorKey = process.env.OPENROUTER_API_KEY?.trim()
    if (!operatorKey) {
      throw new OpenRouterKeyMissingError(userId, 'OpenRouter models on a self-hosted instance use the operator key: set OPENROUTER_API_KEY, or pick a Gemini or local/ model')
    }
    return operatorKey
  },
  onUserCreated() {},
  onUserVerified() {},
  async beforeAccountDelete() {},
  jobTypes: [],
  bootChecks: [],
})

let registered: HostedHooks | null = null

export function setHostedHooks(hooks: HostedHooks): void {
  registered = hooks
}

export function resetHostedHooks(): void {
  registered = null
}

export function hostedHooks(): HostedHooks {
  return registered && isHostedMode() ? registered : SELF_HOST_HOOKS
}

export function getBilling(): Billing {
  return hostedHooks().billing
}
