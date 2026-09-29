import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import type { CheckResult } from '../ai/connectionChecks.js'
import { checkGeminiKey, checkOpenRouter, checkResendKey, checkVertexCredentials, type ApiCheck } from './apiChecks.js'
import {
  buildEnv, chatModelId, renderEnvFile, renderPasteBlock, validateAnswers,
  type ChatProvider, type DecisionsChoice, type EnvSection, type GoogleAccess, type SetupAnswers, type Target,
} from './envFile.js'

// #315 Phase 2 — the `make setup` flow: ask → check → write. Prompts and side
// effects are injected so tests can drive it end to end.

export interface Choice<T extends string> { value: T; label: string }

export interface SetupIO {
  choose<T extends string>(question: string, options: Choice<T>[], fallback: T): Promise<T>
  ask(question: string, fallback?: string): Promise<string>
  /** Not echoed. */
  secret(question: string): Promise<string>
  confirm(question: string, fallback: boolean): Promise<boolean>
  print(line?: string): void
}

export interface SetupDeps {
  fetch?: typeof fetch
  generateVapid?: () => { publicKey: string; privateKey: string }
  checkLocal?: () => Promise<CheckResult>
  checkDecisions?: () => Promise<CheckResult>
  now?: () => Date
}

export interface SetupOptions {
  envPath: string
  target?: Target
  /** Running inside the Vastra container (install.sh): host.docker.internal resolves as-is. */
  inContainer?: boolean
}

export interface SetupResult {
  answers: SetupAnswers
  checks: ApiCheck[]
  /** File written (docker/node), if any. */
  written?: string
  backup?: string
  /** KEY=value block printed for a hosting panel (render). */
  pasted?: string
}

// ─── Questions ─────────────────────────────────────────────────────────────────

export async function collectAnswers(io: SetupIO, opts: { target?: Target }): Promise<SetupAnswers> {
  const target = opts.target ?? await io.choose<Target>('Where will Vastra run?', [
    { value: 'docker', label: 'Docker on this machine (home server, NAS, Mac)' },
    { value: 'node', label: 'Node on this machine, from this checkout' },
    { value: 'render', label: 'Render (prints env vars to paste into the dashboard)' },
  ], 'docker')

  const household = (await io.choose('Who will use it?', [
    { value: 'me', label: 'Just me: only accounts I create can sign in' },
    { value: 'household', label: 'Household: anyone who can reach it may make an account' },
  ], 'me')) === 'household'

  const appUrl = await io.ask(
    target === 'render' ? 'Public URL (https://<name>.onrender.com or your domain)' : 'URL you open Vastra at',
    target === 'render' ? undefined : 'http://localhost:3000',
  )

  const google = await io.choose<GoogleAccess>('Google AI (vision, image generation, embeddings)?', [
    { value: 'gemini', label: 'Gemini API key (free tier at aistudio.google.com)' },
    { value: 'vertex', label: 'Vertex AI (a GCP project + service-account JSON)' },
    { value: 'none', label: 'None' },
  ], 'gemini')
  const a: SetupAnswers = { target, household, appUrl, google, chat: 'none', imageGen: false, decisions: 'none' }
  if (google === 'gemini') a.geminiKey = await io.secret('Gemini API key')
  if (google === 'vertex') {
    a.gcpProject = await io.ask('GCP project id')
    a.gcpLocation = await io.ask('GCP region', 'us-central1')
    a.gcpCredentials = await io.ask(target === 'render'
      ? 'Service-account JSON path on Render (add it as a Secret File, e.g. /etc/secrets/vertex-sa.json)'
      : target === 'docker' ? 'Service-account JSON path inside the container (put it under the data dir, e.g. /data/vertex-sa.json)'
        : 'Service-account JSON path')
  }

  const chatOptions: Choice<ChatProvider>[] = [
    ...(google !== 'none' ? [{ value: 'google' as const, label: 'Google (gemini-2.5-flash)' }] : []),
    { value: 'openrouter', label: 'OpenRouter (any "vendor/model" id, on your key)' },
    { value: 'local', label: 'Your own OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio)' },
    { value: 'none', label: 'None for now' },
  ]
  a.chat = await io.choose('Chat model (suggestions, Discover, Ask)?', chatOptions, google !== 'none' ? 'google' : 'local')
  if (a.chat === 'openrouter') {
    a.openrouterKey = await io.secret('OpenRouter API key')
    a.chatModel = await io.ask('OpenRouter model id', 'mistralai/mistral-small-3.2-24b-instruct')
  }
  if (a.chat === 'local') {
    io.print(target === 'docker'
      ? 'A server on this machine is http://host.docker.internal:<port>/v1 from inside Docker (Ollama: port 11434).'
      : 'Ollama listens on http://localhost:11434/v1 by default.')
    a.localUrl = await io.ask('Server base URL', target === 'docker' ? 'http://host.docker.internal:11434/v1' : 'http://localhost:11434/v1')
    const key = await io.secret('Server API key (Enter for none)')
    if (key) a.localKey = key
    a.chatModel = await io.ask('Model name as the server knows it', 'qwen3-vl:8b')
  }

  if (google !== 'none') {
    a.imageGen = await io.confirm('Real try-on and Make Pretty through Google? (billed per image on your key)', google === 'vertex')
  }

  const decisionOptions: Choice<DecisionsChoice>[] = [
    ...(a.chat === 'openrouter' || a.openrouterKey ? [{ value: 'jev' as const, label: 'Jev on OpenRouter (TypeSafe)' }] : []),
    ...(chatModelId(a) ? [{ value: 'llm' as const, label: 'Your chat model answers yes/no questions' }] : []),
    { value: 'typesafe', label: 'A TypeSafe-compatible server (e.g. CLM-8B clm-serve)' },
    { value: 'none', label: 'None: hide Related, simpler ranking' },
  ]
  a.decisions = await io.choose('Decision model (ranking + Related)?', decisionOptions, decisionOptions[0].value)
  if (a.decisions === 'typesafe') {
    a.decisionsUrl = await io.ask('TypeSafe server URL', 'http://localhost:8700/v1/systemone')
    const key = await io.secret('Its API key (Enter for none)')
    if (key) a.decisionsKey = key
  }

  if (await io.confirm('Send sign-in links by email (Resend)? Otherwise they appear in the server log.', a.household)) {
    a.resendKey = await io.secret('Resend API key')
    a.mailFrom = await io.ask('From address (on a domain verified in Resend)')
  }
  if (await io.confirm('Push notifications (outfit reminders)?', true)) {
    const contact = await io.ask('Contact email for push services (mailto)', 'admin@example.com')
    a.vapid = { publicKey: '', privateKey: '', subject: contact.startsWith('mailto:') ? contact : `mailto:${contact}` }
  }
  return a
}

// ─── Checks ────────────────────────────────────────────────────────────────────

/** Runs `fn` with the chosen env applied, so the shared server checks read it. */
async function withEnv<T>(sections: EnvSection[], a: SetupAnswers, fn: () => Promise<T>, inContainer = false): Promise<T> {
  const saved = new Map<string, string | undefined>()
  const set = (k: string, v: string | undefined) => {
    if (!saved.has(k)) saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const e of sections.flatMap(s => s.entries)) {
    // host.docker.internal is how the container reaches this machine; run on
    // the host, the check has to use localhost instead.
    set(e.key, a.target === 'docker' && !inContainer ? e.value.replace('host.docker.internal', 'localhost') : e.value)
  }
  set('HOSTED_MODE', undefined)
  try { return await fn() } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * The admin route's checks, loaded on first use. The AI client warns about
 * unset keys when it loads; that's server-boot advice, not setup output.
 */
async function serverChecks(): Promise<typeof import('../ai/connectionChecks.js')> {
  const { log, warn } = console
  console.log = console.warn = () => {}
  try { return await import('../ai/connectionChecks.js') } finally { console.log = log; console.warn = warn }
}

function summarise(name: string, result: CheckResult): ApiCheck {
  const checks = (result.body.checks ?? {}) as Record<string, { ok: boolean; error?: string }>
  const parts = Object.entries(checks).map(([k, c]) => `${k} ${c.ok ? 'ok' : `failed${c.error ? ` (${c.error})` : ''}`}`)
  const error = typeof result.body.error === 'string' ? result.body.error : undefined
  return { name, ok: result.body.ok, detail: [error, ...parts].filter(Boolean).join('; ') || undefined }
}

export async function runChecks(a: SetupAnswers, deps: SetupDeps = {}, inContainer = false): Promise<ApiCheck[]> {
  const f = deps.fetch ?? fetch
  const out: ApiCheck[] = []
  if (a.google === 'gemini' && a.geminiKey) out.push(await checkGeminiKey(a.geminiKey, f))
  // A Render or container path doesn't exist on this machine; only check local runs.
  if (a.google === 'vertex' && a.gcpCredentials && a.target === 'node') out.push(checkVertexCredentials(a.gcpCredentials, a.gcpProject))
  if (a.openrouterKey) out.push(await checkOpenRouter(a.openrouterKey, a.chat === 'openrouter' ? a.chatModel : undefined, f))
  if (a.resendKey) out.push(await checkResendKey(a.resendKey, f))

  const sections = buildEnv(a)
  if (a.chat === 'local') {
    out.push(summarise('Model server', await withEnv(sections, a, deps.checkLocal ?? (async () => (await serverChecks()).checkLocalServer()), inContainer)))
  }
  if (a.decisions === 'typesafe' || a.decisions === 'llm' || a.decisions === 'jev') {
    out.push(summarise('Decision model', await withEnv(sections, a, deps.checkDecisions ?? (async () => (await serverChecks()).checkDecisions()), inContainer)))
  }
  return out
}

// ─── Flow ──────────────────────────────────────────────────────────────────────

export async function runSetup(io: SetupIO, opts: SetupOptions, deps: SetupDeps = {}): Promise<SetupResult | null> {
  io.print('Vastra setup: answers go into one commented env file you can also edit by hand.')
  io.print()
  const answers = await collectAnswers(io, opts)
  if (answers.vapid && deps.generateVapid) Object.assign(answers.vapid, deps.generateVapid())

  const problems = validateAnswers(answers)
  if (problems.length) {
    io.print('Setup stopped:')
    for (const p of problems) io.print(`  - ${p}`)
    return null
  }

  io.print()
  io.print('Testing connections…')
  const checks = await runChecks(answers, deps, opts.inContainer)
  for (const c of checks) io.print(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`)
  if (!checks.length) io.print('  (nothing to test)')
  if (checks.some(c => !c.ok) && !await io.confirm('Some checks failed. Write the config anyway?', false)) {
    io.print('Nothing written.')
    return { answers, checks }
  }

  const sections = buildEnv(answers)
  const result: SetupResult = { answers, checks }
  if (answers.target === 'render') {
    result.pasted = renderPasteBlock(sections)
    io.print()
    io.print('Paste these into Render → your service → Environment (they include secrets):')
    io.print()
    io.print(result.pasted.trimEnd())
  } else {
    const previous = existsSync(opts.envPath) ? readFileSync(opts.envPath, 'utf8') : undefined
    const now = deps.now?.() ?? new Date()
    if (previous !== undefined) {
      result.backup = `${opts.envPath}.bak-${now.toISOString().replace(/[:.]/g, '-')}`
      writeFileSync(result.backup, previous, { mode: 0o600 })
      chmodSync(result.backup, 0o600)
    }
    writeFileSync(opts.envPath, renderEnvFile(sections, { previous, now }), { mode: 0o600 })
    chmodSync(opts.envPath, 0o600)
    result.written = opts.envPath
    io.print()
    io.print(`Wrote ${opts.envPath} (mode 600)${result.backup ? `; the old file is at ${result.backup}` : ''}.`)
  }

  io.print()
  io.print('Next:')
  if (answers.target === 'docker') {
    io.print('  docker compose up -d --build        (or ./install.sh for GPU / Ollama profiles)')
    io.print('  docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com')
  } else if (answers.target === 'node') {
    io.print('  npm run web                         (restart it if it is running)')
    io.print('  make create-admin EMAIL=you@example.com')
  } else {
    io.print('  Deploy, then in the Render Shell: node src/transport/web/admin/admin.mjs create-admin you@example.com')
  }
  io.print('  Open the one-time link it prints to sign in as the admin.')
  return result
}
