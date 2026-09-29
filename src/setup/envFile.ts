// #315 Phase 2 — `make setup` turns a handful of answers into the one config
// file a self-hosted Vastra boots with: a commented .env that people can also
// edit by hand. Pure functions only; scripts/setup.ts owns the prompts and
// src/setup/run.ts the flow, checks and writing.

export type Target = 'docker' | 'node' | 'render'
export type GoogleAccess = 'gemini' | 'vertex' | 'none'
export type ChatProvider = 'google' | 'openrouter' | 'local' | 'none'
export type DecisionsChoice = 'jev' | 'llm' | 'typesafe' | 'none'

export interface SetupAnswers {
  target: Target
  /** Household: anyone who can reach the instance may make an account. */
  household: boolean
  appUrl: string
  google: GoogleAccess
  geminiKey?: string
  gcpProject?: string
  gcpLocation?: string
  gcpCredentials?: string
  chat: ChatProvider
  openrouterKey?: string
  /** "vendor/model" for OpenRouter, the served name for a local server. */
  chatModel?: string
  localUrl?: string
  localKey?: string
  /** Real try-on / Make Pretty through Google; otherwise mock images. */
  imageGen: boolean
  decisions: DecisionsChoice
  decisionsUrl?: string
  decisionsKey?: string
  resendKey?: string
  mailFrom?: string
  vapid?: { publicKey: string; privateKey: string; subject: string }
}

export interface EnvEntry { key: string; value: string; secret?: boolean }
export interface EnvSection { title: string; notes: string[]; entries: EnvEntry[] }

const GEMINI_DEFAULT = 'gemini-2.5-flash'

/** Every key `make setup` owns. Keys outside this set in an old file are kept. */
export const MANAGED_KEYS = new Set([
  'HOSTED_MODE', 'ALLOW_SIGNUPS', 'WEB_APP_URL', 'NODE_ENV',
  'GEMINI_API_KEY', 'GCP_PROJECT_ID', 'GCP_LOCATION', 'GCP_IMAGE_GEN_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENROUTER_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY',
  'VISION_MODEL', 'TEXT_MODEL', 'AGENT_MODEL',
  'MOCK_AI_IMAGE_GEN', 'MOCK_EMBEDDINGS', 'TEXT_EMBED_ENABLED', 'IMAGE_EMBED_ENABLED',
  'DECISIONS_PROVIDER', 'DECISIONS_URL', 'DECISIONS_API_KEY', 'DECISIONS_MODEL',
  'RESEND_API_KEY', 'RESEND_FROM_NOREPLY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_EMAIL',
])

/** The model id the chat choice resolves to, or null when there is none. */
export function chatModelId(a: SetupAnswers): string | null {
  switch (a.chat) {
    case 'google': return a.google === 'none' ? null : GEMINI_DEFAULT
    case 'openrouter': return a.chatModel ?? null
    case 'local': return a.chatModel ? `local/${a.chatModel.replace(/^local\//, '')}` : null
    case 'none': return null
  }
}

/** Problems that make the answers unusable; empty when they can be written. */
export function validateAnswers(a: SetupAnswers): string[] {
  const problems: string[] = []
  try {
    const url = new URL(a.appUrl)
    if (!/^https?:$/.test(url.protocol)) problems.push('App URL must be http(s)')
  } catch { problems.push('App URL is not a valid URL') }
  if (a.google === 'gemini' && !a.geminiKey) problems.push('Gemini needs an API key')
  if (a.google === 'vertex' && (!a.gcpProject || !a.gcpCredentials)) problems.push('Vertex needs a GCP project id and a service-account JSON path')
  if (a.chat === 'google' && a.google === 'none') problems.push('Chat through Google needs Gemini or Vertex access')
  if (a.chat === 'openrouter' && (!a.openrouterKey || !a.chatModel?.includes('/'))) problems.push('OpenRouter needs a key and a "vendor/model" id')
  if (a.chat === 'local') {
    if (!a.localUrl || !/^https?:\/\//.test(a.localUrl)) problems.push('The local model server needs an http(s) base URL')
    if (!a.chatModel) problems.push('The local model server needs a model name')
  }
  if (a.imageGen && a.google === 'none') problems.push('Image generation needs Gemini or Vertex access')
  if (a.decisions === 'jev' && !a.openrouterKey) problems.push('Jev decisions need an OpenRouter key')
  if (a.decisions === 'llm' && !chatModelId(a)) problems.push('LLM decisions need a chat model')
  if (a.decisions === 'typesafe' && !a.decisionsUrl) problems.push('A TypeSafe decision server needs its URL')
  if (a.resendKey && !a.mailFrom) problems.push('Email needs a from address')
  return problems
}

export function buildEnv(a: SetupAnswers): EnvSection[] {
  const sections: EnvSection[] = []
  const chatId = chatModelId(a)

  sections.push({
    title: 'Instance',
    notes: [
      'Self-host: HOSTED_MODE stays unset (no wallet, no Stripe).',
      'ALLOW_SIGNUPS=false: only accounts you create can sign in. First admin:',
      a.target === 'docker'
        ? '  docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com'
        : '  make create-admin EMAIL=you@example.com',
    ],
    entries: [
      { key: 'ALLOW_SIGNUPS', value: String(a.household) },
      { key: 'WEB_APP_URL', value: a.appUrl.replace(/\/+$/, '') },
      ...(a.target === 'render' ? [{ key: 'NODE_ENV', value: 'production' }] : []),
    ],
  })

  const google: EnvEntry[] = []
  if (a.google === 'gemini') google.push({ key: 'GEMINI_API_KEY', value: a.geminiKey!, secret: true })
  if (a.google === 'vertex') {
    google.push(
      { key: 'GCP_PROJECT_ID', value: a.gcpProject! },
      { key: 'GCP_LOCATION', value: a.gcpLocation || 'us-central1' },
      { key: 'GCP_IMAGE_GEN_LOCATION', value: 'global' },
      { key: 'GOOGLE_APPLICATION_CREDENTIALS', value: a.gcpCredentials! },
    )
  }
  if (google.length) {
    sections.push({
      title: a.google === 'vertex' ? 'Google (Vertex AI)' : 'Google (Gemini API key)',
      notes: a.google === 'vertex'
        ? ['Every Google call bills to this GCP project. The service-account JSON must be readable by the server.']
        : ['Free key from https://aistudio.google.com/apikey'],
      entries: google,
    })
  }

  const models: EnvEntry[] = []
  const modelNotes: string[] = []
  if (a.chat === 'openrouter') {
    models.push({ key: 'OPENROUTER_API_KEY', value: a.openrouterKey!, secret: true })
    modelNotes.push('Model ids with a "/" route through OpenRouter on your key.')
  } else if (a.openrouterKey) {
    models.push({ key: 'OPENROUTER_API_KEY', value: a.openrouterKey, secret: true })
  }
  if (a.chat === 'local') {
    models.push({ key: 'OPENAI_COMPAT_BASE_URL', value: a.localUrl!.replace(/\/+$/, '') })
    if (a.localKey) models.push({ key: 'OPENAI_COMPAT_API_KEY', value: a.localKey, secret: true })
    modelNotes.push('local/<name> ids go to your OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio).')
    if (a.target === 'docker' && /localhost|127\.0\.0\.1/.test(a.localUrl!)) {
      modelNotes.push('Inside Docker, localhost is the container: use http://host.docker.internal:<port>/v1 for a server on this machine.')
    }
  }
  if (chatId) {
    // Vision stays on Google when chat goes to OpenRouter: categorize and tag
    // scans are free tasks and never spend OpenRouter credit.
    const vision = a.chat === 'openrouter' && a.google !== 'none' ? GEMINI_DEFAULT : chatId
    models.push({ key: 'VISION_MODEL', value: vision }, { key: 'TEXT_MODEL', value: chatId }, { key: 'AGENT_MODEL', value: chatId })
  } else {
    modelNotes.push('No chat model: categorize, suggestions and Ask stay off until you add one.')
  }
  if (models.length || modelNotes.length) sections.push({ title: 'Chat + vision models', notes: modelNotes, entries: models })

  const vertex = a.google === 'vertex'
  const textEmbeds = a.google !== 'none'
  sections.push({
    title: 'Images + embeddings',
    notes: [
      a.imageGen ? 'Try-on and Make Pretty use Google image generation (paid per image on your key).' : 'Try-on and Make Pretty return placeholder images.',
      textEmbeds
        ? (vertex ? 'Search uses Google text + image embeddings.' : 'Search uses Google text embeddings; image embeddings need Vertex, so they stay off.')
        : 'Search uses placeholder embeddings.',
    ],
    entries: [
      { key: 'MOCK_AI_IMAGE_GEN', value: String(!a.imageGen) },
      { key: 'MOCK_EMBEDDINGS', value: String(!textEmbeds) },
      ...(textEmbeds ? [{ key: 'TEXT_EMBED_ENABLED', value: 'true' }, { key: 'IMAGE_EMBED_ENABLED', value: String(vertex) }] : []),
    ],
  })

  const decisions: EnvEntry[] = []
  if (a.decisions === 'jev') decisions.push({ key: 'DECISIONS_PROVIDER', value: 'openrouter' })
  if (a.decisions === 'llm') decisions.push({ key: 'DECISIONS_PROVIDER', value: 'llm' }, { key: 'DECISIONS_MODEL', value: chatId! })
  if (a.decisions === 'typesafe') {
    decisions.push({ key: 'DECISIONS_PROVIDER', value: 'typesafe' }, { key: 'DECISIONS_URL', value: a.decisionsUrl! })
    if (a.decisionsKey) decisions.push({ key: 'DECISIONS_API_KEY', value: a.decisionsKey, secret: true })
  }
  if (a.decisions === 'none') decisions.push({ key: 'DECISIONS_PROVIDER', value: 'none' })
  sections.push({
    title: 'Decisions (ranking + Related)',
    notes: [a.decisions === 'none' ? 'No decision model: Related sections are hidden and ranking falls back.' : 'Ranks suggestions and fills the Related rows.'],
    entries: decisions,
  })

  if (a.resendKey) {
    sections.push({
      title: 'Email (Resend)',
      notes: ['Sign-in links are emailed. Without this they are printed in the server log.'],
      entries: [{ key: 'RESEND_API_KEY', value: a.resendKey, secret: true }, { key: 'RESEND_FROM_NOREPLY', value: a.mailFrom! }],
    })
  }
  if (a.vapid) {
    sections.push({
      title: 'Push notifications',
      notes: ['Generated for this instance. Changing them unsubscribes every device.'],
      entries: [
        { key: 'VAPID_PUBLIC_KEY', value: a.vapid.publicKey },
        { key: 'VAPID_PRIVATE_KEY', value: a.vapid.privateKey, secret: true },
        { key: 'VAPID_EMAIL', value: a.vapid.subject },
      ],
    })
  }
  return sections
}

/** Parses KEY=value lines; comments and blanks are skipped. Quotes are stripped. */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '')
    out.set(m[1], value)
  }
  return out
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@,+=-]*$/.test(value) ? value : JSON.stringify(value)
}

/**
 * The file text. Keys from `previous` that setup doesn't manage (tuning knobs,
 * GPU shares written by install.sh) are carried over at the end.
 */
export function renderEnvFile(sections: EnvSection[], opts: { previous?: string; now?: Date } = {}): string {
  const lines = [
    `# Written by \`make setup\` on ${(opts.now ?? new Date()).toISOString().slice(0, 19)}Z. Edit by hand or re-run it.`,
    '# Every option is documented in .env.example. Keep this file private (mode 600): it holds your keys.',
  ]
  for (const s of sections) {
    lines.push('', `# ── ${s.title} ${'─'.repeat(Math.max(3, 70 - s.title.length))}`)
    for (const n of s.notes) lines.push(`# ${n}`)
    for (const e of s.entries) lines.push(`${e.key}=${quote(e.value)}`)
  }
  const kept = [...parseEnvFile(opts.previous ?? '')].filter(([k]) => !MANAGED_KEYS.has(k))
  if (kept.length) {
    lines.push('', '# ── Kept from your previous file ────────────────────────────────────────')
    for (const [k, v] of kept) lines.push(`${k}=${quote(v)}`)
  }
  return lines.join('\n') + '\n'
}

/** KEY=value lines to paste into a host's environment panel (Render). Secrets included. */
export function renderPasteBlock(sections: EnvSection[]): string {
  return sections.flatMap(s => s.entries).map(e => `${e.key}=${e.value}`).join('\n') + '\n'
}
