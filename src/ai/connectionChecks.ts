import { listLocalModels, localChatCompletion, localModelConfig, localModelName, isLocalModel, readLocalJson } from './localModel.js'
import { decisionsProviderInfo, generateDecisions, type DecisionsQuestions } from './decisions.js'
import { authHeaders, modelServerConfig, modelServerLoad, redactKey } from './modelServers.js'

// "Test connection" for the instance's model servers (#289, #351), shared by
// the admin route (POST /api/admin/connectors/*/test) and `make setup` (#315),
// so both report the same checks. Everything reads the configured env: a
// caller can name a model, never a URL (SSRF), and keys are never echoed.
//
// Each capability is reported on its own, because support varies by server
// and chat template (llama.cpp needs --jinja for tools, vision needs a VLM).

export interface CheckResult {
  /** HTTP status for the admin route: 400 when nothing is configured to test. */
  status: 200 | 400
  body: Record<string, unknown> & { ok: boolean }
}

type Check = { ok: boolean; error?: string }
type TimedCheck = Check & { latencyMs?: number }

const PROBE_TIMEOUT_MS = 30_000
const MODEL_RE = /^[\w.:/@-]{1,200}$/
// 8×8 white PNG. Some servers reject 1×1 images.
const PROBE_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC'

function configuredLocalModel(): string | undefined {
  for (const id of [process.env.AGENT_MODEL, process.env.VISION_MODEL, process.env.TEXT_MODEL]) {
    if (id && isLocalModel(id)) return localModelName(id)
  }
  return undefined
}

async function probe(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await localChatCompletion(body, AbortSignal.timeout(PROBE_TIMEOUT_MS))
  const json = await readLocalJson(res) as { choices?: Array<{ message?: Record<string, unknown> }> }
  return json.choices?.[0]?.message ?? {}
}

/** The OpenAI-compatible chat server (OPENAI_COMPAT_BASE_URL): models, chat, vision, tools. */
export async function checkLocalServer(requested?: unknown): Promise<CheckResult> {
  let config
  try { config = localModelConfig() } catch (err) {
    return { status: 400, body: { ok: false, error: (err as Error).message } }
  }
  const redact = (err: unknown) => {
    let text = err instanceof Error ? err.message : String(err)
    if (config.apiKey) text = text.split(config.apiKey).join('[redacted]')
    return text.slice(0, 300)
  }
  const fail = (err: unknown): Check => ({ ok: false, error: redact(err) })

  if (requested !== undefined && (typeof requested !== 'string' || !MODEL_RE.test(requested))) {
    return { status: 400, body: { ok: false, error: 'Invalid model id' } }
  }

  let models: string[] = []
  let modelsCheck: Check
  try { models = await listLocalModels(); modelsCheck = { ok: true } } catch (err) { modelsCheck = fail(err) }

  const model = (requested ? localModelName(requested.startsWith('local/') ? requested : `local/${requested}`) : undefined)
    ?? configuredLocalModel() ?? models[0]
  if (!model) {
    return { status: 200, body: { ok: false, baseUrl: config.baseUrl, models, checks: { models: modelsCheck }, error: 'No model to test: pass { model } or set a local/ model id' } }
  }

  const [chat, vision, tools] = await Promise.all([
    probe({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] })
      .then((m): Check => typeof m.content === 'string' && m.content.trim() ? { ok: true } : { ok: false, error: 'Empty reply' }, fail),
    probe({ model, max_tokens: 16, messages: [{ role: 'user', content: [
      { type: 'text', text: 'What colour is this image? One word.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE}` } },
    ] }] })
      .then((m): Check => typeof m.content === 'string' && m.content.trim() ? { ok: true } : { ok: false, error: 'Empty reply' }, fail),
    probe({ model, max_tokens: 64, tool_choice: 'auto',
      messages: [{ role: 'user', content: 'Call the ping tool now.' }],
      tools: [{ type: 'function', function: { name: 'ping', description: 'Health check. Always call it when asked.', parameters: { type: 'object', properties: {} } } }] })
      .then((m): Check => Array.isArray(m.tool_calls) && m.tool_calls.length ? { ok: true } : { ok: false, error: 'Model answered without calling the tool' }, fail),
  ])

  return { status: 200, body: { ok: chat.ok, baseUrl: config.baseUrl, model, models, checks: { models: modelsCheck, chat, vision, tools } } }
}

// One probe per question type, sent through generateDecisions so it exercises
// the real path: token fitting, the in-flight limit and answer normalisation.
// Nothing about the user goes in the probe.
const DECISION_PROBES: Record<'noul' | 'choice' | 'score', DecisionsQuestions> = {
  noul: { probe: { type: 'noul', instructions: 'Is a wool coat suitable for this weather?' } },
  choice: { probe: { type: 'choice', instructions: 'Which layer suits this weather best?', criteria: { coat: 'a wool coat', tee: 'a t-shirt' } } },
  score: { probe: { type: 'score', instructions: 'How warm should the outfit be?', criteria: ['light', 'medium', 'warm'] } },
}
const DECISION_PROBE_STATE = { weather: { temperature_c: 2, condition: 'Snow' } }

function validAnswer(kind: keyof typeof DECISION_PROBES, answer: unknown): string | null {
  const a = answer as Record<string, unknown> | undefined
  if (!a) return 'No answer returned'
  if (kind === 'noul') return typeof a.noul === 'number' && a.noul >= 0 && a.noul <= 1 ? null : 'noul is not a probability'
  if (kind === 'choice') return a.choice === 'coat' || a.choice === 'tee' ? null : 'choice is not one of the options'
  return typeof a.score === 'number' && Number.isFinite(a.score) ? null : 'score is not a number'
}

/** The decision provider (CLM-8B on clm-serve, Jev on OpenRouter, or the llm fallback). */
export async function checkDecisions(): Promise<CheckResult> {
  const info = decisionsProviderInfo()
  if (!info) {
    return { status: 400, body: {
      ok: false,
      error: 'No decision provider is configured: set DECISIONS_PROVIDER=typesafe + DECISIONS_URL (e.g. CLM-8B at http://clm:8700/v1/systemone), or OPENROUTER_API_KEY for Jev',
    } }
  }
  const server = info.kind === 'typesafe' ? modelServerConfig('decisions') : undefined
  const redact = (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err)
    return (server ? redactKey(text, server) : text).slice(0, 300)
  }

  const run = async (kind: keyof typeof DECISION_PROBES): Promise<TimedCheck> => {
    const started = Date.now()
    try {
      const result = await generateDecisions(DECISION_PROBE_STATE, DECISION_PROBES[kind], { timeoutMs: PROBE_TIMEOUT_MS })
      const problem = validAnswer(kind, result.answers.probe)
      return problem ? { ok: false, error: problem, latencyMs: Date.now() - started } : { ok: true, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, error: redact(err), latencyMs: Date.now() - started }
    }
  }

  // clm-serve exposes GET /health at the server root; other TypeSafe servers
  // may not, so it's reported but doesn't decide `ok`.
  const health = async (): Promise<Check> => {
    if (!server) return { ok: true }
    try {
      const r = await fetch(new URL('/health', server.baseUrl), {
        signal: AbortSignal.timeout(10_000), redirect: 'error', headers: authHeaders(server),
      })
      await r.body?.cancel()
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` }
    } catch (err) {
      return { ok: false, error: redact(err) }
    }
  }

  // Sequential: a one-slot server would otherwise queue them anyway, and the
  // latencies read cleaner one at a time.
  const noul = await run('noul')
  const choice = await run('choice')
  const score = await run('score')
  return { status: 200, body: {
    ok: noul.ok,
    provider: info.kind,
    model: info.model,
    ...(server ? { endpoint: server.baseUrl, load: modelServerLoad('decisions') } : {}),
    checks: { health: await health(), noul, choice, score },
  } }
}
