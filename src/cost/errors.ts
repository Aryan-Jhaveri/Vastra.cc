export class InsufficientTokensError extends Error {
  readonly code = 'INSUFFICIENT_TOKENS'

  constructor(
    readonly required: number,
    readonly balance: number,
  ) {
    super(`Insufficient tokens: need ${required}, have ${balance}`)
    this.name = 'InsufficientTokensError'
  }
}

export class OpenRouterKeyMissingError extends Error {
  readonly code = 'OPENROUTER_KEY_MISSING'

  constructor(userId: string, message?: string) {
    super(message ?? `No per-user OpenRouter key found for user ${userId}. Call mintForUser first.`)
    this.name = 'OpenRouterKeyMissingError'
  }
}

/**
 * #345 — a billable call to a provider/model with no configured wholesale
 * price. Thrown before the provider is contacted, so there is no spend.
 */
export class UnpricedModelError extends Error {
  readonly code = 'UNPRICED_MODEL'

  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(`No wholesale price configured for billable model "${provider}:${model}"`)
    this.name = 'UnpricedModelError'
  }
}
