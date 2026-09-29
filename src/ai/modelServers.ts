// #315 — the operator's own model servers, one per capability. Vastra speaks
// two open wire contracts to them: the OpenAI API (chat/vision, image edits,
// embeddings) and TypeSafe (decisions). This module owns what every such call
// shares: where the server is, its key, how long to wait, and how many calls
// it may take at once.
//
// Config is instance-level only (env now, `vastra.env` from `make setup`
// later), never per-user: a user-supplied URL would make every model call an
// SSRF primitive against the server's network. Read per call so tests and a
// config reload need no restart.
//
// | capability | URL                         | key                      | default in-flight |
// |------------|-----------------------------|--------------------------|-------------------|
// | chat       | OPENAI_COMPAT_BASE_URL      | OPENAI_COMPAT_API_KEY    | 4                 |
// | image      | IMAGE_GEN_BASE_URL → chat   | IMAGE_GEN_API_KEY        | 1                 |
// | embed      | EMBED_BASE_URL → chat       | EMBED_API_KEY            | 4                 |
// | decisions  | DECISIONS_URL (full path)   | DECISIONS_API_KEY        | 4                 |
//
// "→ chat" means an unset URL falls back to the chat server (and its key),
// for single-server setups like Ollama. Each capability also reads
// <PREFIX>_TIMEOUT_MS, <PREFIX>_MAX_CONCURRENCY and <PREFIX>_MAX_QUEUE.
//
// The in-flight cap is what keeps a GPU server healthy: vLLM and llama.cpp
// have a fixed number of slots, and flooding them only adds latency or OOMs.
// Excess calls wait in a bounded FIFO queue; a full queue fails fast with a
// 503 (isModelBusy) instead of piling up behind a slow image job.

export type ModelServerKind = 'chat' | 'image' | 'embed' | 'decisions'

interface Spec {
  /** Env prefix for the URL/key/timeout/concurrency variables. */
  prefix: string
  urlEnv: string
  /** Capability whose URL + key are used when this one's URL is unset. */
  fallback?: ModelServerKind
  /** The URL is the full endpoint (TypeSafe), not an API base. */
  fullUrl?: boolean
  defaultTimeoutMs: number
  defaultConcurrency: number
  example: string
}

const SPECS: Record<ModelServerKind, Spec> = {
  chat: { prefix: 'OPENAI_COMPAT', urlEnv: 'OPENAI_COMPAT_BASE_URL', defaultTimeoutMs: 180_000, defaultConcurrency: 4, example: 'http://localhost:11434/v1' },
  image: { prefix: 'IMAGE_GEN', urlEnv: 'IMAGE_GEN_BASE_URL', fallback: 'chat', defaultTimeoutMs: 300_000, defaultConcurrency: 1, example: 'http://qwen-image:8091/v1' },
  embed: { prefix: 'EMBED', urlEnv: 'EMBED_BASE_URL', fallback: 'chat', defaultTimeoutMs: 60_000, defaultConcurrency: 4, example: 'http://qwen-embed:8002/v1' },
  decisions: { prefix: 'DECISIONS', urlEnv: 'DECISIONS_URL', fullUrl: true, defaultTimeoutMs: 30_000, defaultConcurrency: 4, example: 'http://clm:8700/v1/systemone' },
}

const DEFAULT_MAX_QUEUE = 32

export interface ModelServerConfig {
  kind: ModelServerKind
  /** API base (no trailing slash), or the full endpoint for decisions. */
  baseUrl: string
  apiKey?: string
  timeoutMs: number
  maxConcurrency: number
  maxQueue: number
  /** Which env var the URL came from (shown by Test connection). */
  urlSource: string
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function validateUrl(raw: string, envName: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${envName} is not a valid URL`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${envName} must be http(s)`)
  if (url.username || url.password) throw new Error(`${envName} must not embed credentials; use the matching _API_KEY variable`)
  return url
}

/** Resolve a capability's server. Throws a setup hint when it isn't configured. */
export function modelServerConfig(kind: ModelServerKind): ModelServerConfig {
  const spec = SPECS[kind]
  const own = process.env[spec.urlEnv]?.trim()
  let urlSource = spec.urlEnv
  let raw = own
  let apiKey = process.env[`${spec.prefix}_API_KEY`]?.trim() || undefined
  if (!raw && spec.fallback) {
    const fb = SPECS[spec.fallback]
    raw = process.env[fb.urlEnv]?.trim()
    urlSource = fb.urlEnv
    apiKey = apiKey ?? (process.env[`${fb.prefix}_API_KEY`]?.trim() || undefined)
  }
  if (!raw) {
    const also = spec.fallback ? ` (or ${SPECS[spec.fallback].urlEnv})` : ''
    throw new Error(`${kind} model server needs ${spec.urlEnv}${also}, e.g. ${spec.example}`)
  }
  const url = validateUrl(raw, urlSource)
  return {
    kind,
    baseUrl: spec.fullUrl ? url.href : url.href.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: positiveInt(process.env[`${spec.prefix}_TIMEOUT_MS`], spec.defaultTimeoutMs),
    maxConcurrency: positiveInt(process.env[`${spec.prefix}_MAX_CONCURRENCY`], spec.defaultConcurrency),
    maxQueue: positiveInt(process.env[`${spec.prefix}_MAX_QUEUE`], DEFAULT_MAX_QUEUE),
    urlSource,
  }
}

export function isModelServerConfigured(kind: ModelServerKind): boolean {
  try { modelServerConfig(kind); return true } catch { return false }
}

export function authHeaders(config: Pick<ModelServerConfig, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

/** Strip the API key from text that might echo it (errors, probe output). */
export function redactKey(text: string, config: Pick<ModelServerConfig, 'apiKey'>): string {
  return config.apiKey ? text.split(config.apiKey).join('[redacted]') : text
}

// ─── In-flight limiter ────────────────────────────────────────────────────────

/** 503 so isModelBusy / withRetry treat a full queue like an overloaded provider. */
export class ModelServerBusyError extends Error {
  readonly status = 503
  constructor(kind: ModelServerKind, queued: number) {
    super(`${kind} model server is busy: ${queued} calls already waiting`)
    this.name = 'ModelServerBusyError'
  }
}

interface Waiter { start: () => void }

class Slots {
  active = 0
  readonly waiting: Waiter[] = []
}

const slots = new Map<ModelServerKind, Slots>()

function slotsFor(kind: ModelServerKind): Slots {
  let s = slots.get(kind)
  if (!s) { s = new Slots(); slots.set(kind, s) }
  return s
}

/**
 * Wait for a free slot on `kind`'s server. Resolves to a release function that
 * must be called exactly once (extra calls are ignored). Rejects when the
 * queue is full or `signal` aborts while waiting.
 */
export function acquireSlot(config: ModelServerConfig, signal?: AbortSignal): Promise<() => void> {
  const s = slotsFor(config.kind)
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      s.active--
      // Aborted waiters remove themselves, so the head is always live.
      const next = s.waiting.shift()
      if (next) next.start()
    }
    const start = () => {
      signal?.removeEventListener('abort', onAbort)
      s.active++
      resolve(release)
    }
    const waiter: Waiter = { start }
    const onAbort = () => {
      const i = s.waiting.indexOf(waiter)
      if (i >= 0) s.waiting.splice(i, 1)
      reject(signal!.reason)
    }
    if (s.active < config.maxConcurrency) return start()
    if (s.waiting.length >= config.maxQueue) return reject(new ModelServerBusyError(config.kind, s.waiting.length))
    signal?.addEventListener('abort', onAbort, { once: true })
    s.waiting.push(waiter)
  })
}

/** Current load per capability (Test connection + /health). */
export function modelServerLoad(kind: ModelServerKind): { active: number; queued: number } {
  const s = slotsFor(kind)
  return { active: s.active, queued: s.waiting.length }
}

/** Test-only: forget all slot state between cases. */
export function __resetModelServerSlots(): void {
  slots.clear()
}

/**
 * Keep the slot until the body is fully read, cancelled or errors. A server
 * is still busy while it streams tokens, so releasing on headers would let a
 * second stream start on a one-slot server.
 */
function holdSlotUntilConsumed(res: Response, release: () => void): Response {
  if (!res.body) { release(); return res }
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) { release(); controller.close(); return }
        controller.enqueue(value)
      } catch (err) {
        release()
        controller.error(err)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason).catch(() => {})
    },
  })
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export interface ServerFetchInit {
  method?: 'GET' | 'POST'
  /** JSON-serialised with Content-Type set, unless it's FormData (multipart). */
  body?: unknown
  signal?: AbortSignal
  /** Override the capability timeout (e.g. short probes). */
  timeoutMs?: number
}

/**
 * Call `path` on `kind`'s server under its in-flight limit. The timeout covers
 * the queue wait too, so a call never waits longer than the operator allows.
 * No redirects (a redirect could point the key at another host). Throws on
 * non-2xx with the server's message (key redacted) and `status` attached.
 * The returned body holds the slot until it is read or cancelled.
 */
export async function serverFetch(kind: ModelServerKind, path: string, init: ServerFetchInit = {}): Promise<Response> {
  const config = modelServerConfig(kind)
  const timeout = AbortSignal.timeout(init.timeoutMs ?? config.timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const release = await acquireSlot(config, signal)
  let res: Response
  try {
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
    const headers: Record<string, string> = { ...authHeaders(config) }
    if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
    res = await fetch(`${config.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      signal,
      redirect: 'error',
      headers,
      body: init.body === undefined ? undefined : isForm ? init.body as FormData : JSON.stringify(init.body),
    })
  } catch (err) {
    release()
    throw err
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    release()
    const label = kind === 'decisions' ? 'Decisions server' : kind === 'chat' ? 'Local model' : `${kind[0].toUpperCase()}${kind.slice(1)} server`
    throw Object.assign(new Error(`${label} HTTP ${res.status}: ${redactKey(text, config).slice(0, 300)}`), { status: res.status })
  }
  return holdSlotUntilConsumed(res, release)
}

/** Parse a JSON body, refusing anything over `maxBytes` (a hostile or broken server). */
export async function readJsonCapped(res: Response, maxBytes: number, label = 'Model server'): Promise<unknown> {
  if (!res.body) throw new Error(`${label} returned no body`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`${label} response exceeds size cap`)
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
