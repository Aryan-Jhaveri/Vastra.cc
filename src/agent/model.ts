// The chat model. Chat has a daily free allowance, so like the other free
// tasks (suggest, discover) it is pinned to Gemini per Decision 1A rather than
// following TEXT_MODEL, which may point at OpenRouter — where per-user keys
// start at a $0 limit and a free turn would fail. AGENT_MODEL overrides it
// (e.g. a self-hoster pointing chat at an OpenRouter or local model).
// Unset, it follows a local/ TEXT_MODEL like the other free tasks (#289), so
// a self-hoster's own server answers chat too. Read per call.
import { freeTextModel } from '../ai/localModel.js'

export const DEFAULT_AGENT_MODEL = 'gemini-2.5-flash'

export function agentModel(): string {
  return process.env.AGENT_MODEL || freeTextModel()
}
