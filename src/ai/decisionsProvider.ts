import { providerForModel } from './client.js'
import { isLocalModel, isLocalModelConfigured } from './localModel.js'
import { modelServerConfig } from './modelServers.js'

// Which decision provider is configured (see the header of decisions.ts).
// Kept apart from the HTTP client so code that only needs labels or the
// "is it configured" answer (instrumentation, feature flags) doesn't depend
// on the client module, which tests replace wholesale.

export const JEV_MODEL = 'typesafe/jev-1.13'

export type DecisionsProviderKind = 'openrouter' | 'typesafe' | 'llm'

export interface DecisionsProviderInfo {
  kind: DecisionsProviderKind
  /** ai_calls.provider / ai_calls.model labels for this provider. */
  provider: string
  model: string
}

/** The configured decision provider, or null when none is usable. Read per call. */
export function decisionsProviderInfo(): DecisionsProviderInfo | null {
  const kind = (process.env.DECISIONS_PROVIDER?.trim() || 'openrouter') as DecisionsProviderKind
  if (kind === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_DISABLED === 'true') return null
    return { kind, provider: 'typesafe', model: JEV_MODEL }
  }
  if (kind === 'typesafe') {
    try { typesafeEndpoint() } catch { return null }
    return { kind, provider: 'self', model: process.env.DECISIONS_MODEL?.trim() || 'typesafe-compatible' }
  }
  if (kind === 'llm') {
    const model = process.env.DECISIONS_MODEL?.trim()
    if (!model || !isChatModelUsable(model)) return null
    return { kind, provider: providerForModel(model), model }
  }
  return null
}

export function isDecisionsConfigured(): boolean {
  return decisionsProviderInfo() !== null
}

function isChatModelUsable(model: string): boolean {
  if (isLocalModel(model)) return isLocalModelConfigured()
  if (model.includes('/')) return Boolean(process.env.OPENROUTER_API_KEY) && process.env.OPENROUTER_DISABLED !== 'true'
  return Boolean(process.env.GEMINI_API_KEY || process.env.GCP_PROJECT_ID)
}

/** The operator's TypeSafe endpoint (full URL, e.g. …:8700/v1/systemone). URL rules live in modelServers.ts. */
export function typesafeEndpoint(): { url: string; apiKey?: string } {
  let config
  try { config = modelServerConfig('decisions') } catch (err) {
    throw new Error(`[decisions] DECISIONS_PROVIDER=typesafe: ${(err as Error).message}`)
  }
  return { url: config.baseUrl, apiKey: config.apiKey }
}
