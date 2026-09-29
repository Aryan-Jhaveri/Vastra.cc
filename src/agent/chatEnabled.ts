import { isHostedMode } from '../hostedMode.js'
import { isLocalModel, isLocalModelConfigured } from '../ai/localModel.js'
import { agentModel } from './model.js'

// #328 — whether the Ask surface is on. Read per call so tests can flip env.
//
// A text model has to be usable, or self-hosters would see an Ask tab that
// can't answer: Gemini ids need a Developer API key or a Vertex project;
// "vendor/model" ids route through OpenRouter and need its key; "local/name"
// ids need the operator's OpenAI-compatible server URL (#289).
export function isTextModelConfigured(): boolean {
  const model = agentModel()
  if (isLocalModel(model)) return isLocalModelConfigured()
  if (model.includes('/')) return Boolean(process.env.OPENROUTER_API_KEY) && process.env.OPENROUTER_DISABLED !== 'true'
  return Boolean(process.env.GEMINI_API_KEY || process.env.GCP_PROJECT_ID)
}

/** The hosted global daily chat spend cap in cents, or null when unset/invalid. */
export function chatSpendCapCents(): number | null {
  const cents = Number(process.env.CHAT_DAILY_SPEND_CAP_CENTS)
  return Number.isFinite(cents) && cents > 0 ? cents : null
}

// Hosted (vastra.cc) keeps chat off until CHAT_ENABLED=true, and also while no
// daily spend cap is set: the cap is the kill switch, so chat fails closed
// without one (#328 threat #1).
export function isChatEnabled(): boolean {
  if (!isTextModelConfigured()) return false
  if (!isHostedMode()) return true
  return process.env.CHAT_ENABLED === 'true' && chatSpendCapCents() !== null
}
