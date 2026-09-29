// #289 — OpenAI-compatible connector for self-hosted models (Ollama, llama.cpp,
// vLLM, LM Studio). A `local/<name>` model id routes here, e.g.
// VISION_MODEL=local/qwen3-vl-8b; the prefix is stripped before sending.
//
// Config is instance-level only (env now, the admin-only /setup wizard later),
// never a per-user URL: a user-supplied URL would turn every model call into an
// SSRF primitive against the server's network. Read per call so tests and the
// wizard can change it without a restart.

import { isModelServerConfigured, modelServerConfig, readJsonCapped, serverFetch } from './modelServers.js'

export const LOCAL_MODEL_PREFIX = 'local/'
export const LOCAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export function isLocalModel(modelId: string): boolean {
  return modelId.startsWith(LOCAL_MODEL_PREFIX)
}

export function localModelName(modelId: string): string {
  return modelId.slice(LOCAL_MODEL_PREFIX.length)
}

export interface LocalModelConfig {
  /** Includes the API version path, e.g. http://llm:8080/v1 (no trailing slash). */
  baseUrl: string
  apiKey?: string
  timeoutMs: number
}

/** The chat server (OPENAI_COMPAT_*). URL rules live in modelServers.ts. */
export function localModelConfig(): LocalModelConfig {
  const { baseUrl, apiKey, timeoutMs } = modelServerConfig('chat')
  return { baseUrl, apiKey, timeoutMs }
}

export const FREE_TASK_GEMINI_MODEL = 'gemini-2.5-flash'

/**
 * Model for free text tasks (suggest, discover, try-on wear hints). Pinned to
 * Gemini per Decision 1A so a free task never spends a user's OpenRouter
 * credit, even when TEXT_MODEL points at OpenRouter. A `local/` TEXT_MODEL is
 * the operator's own server and costs nothing, so free tasks follow it (#289).
 * Read per call. Routes pass the same value to runInstrumented as the label.
 */
export function freeTextModel(): string {
  const text = process.env.TEXT_MODEL
  return text && isLocalModel(text) ? text : FREE_TASK_GEMINI_MODEL
}

/**
 * Model for bulk item detection (bounding boxes). DETECTION_MODEL wins; else a
 * `local/` VISION_MODEL, so a self-hoster's vision server handles detection
 * too instead of silently calling Gemini; else Gemini Flash. Read per call.
 */
export function detectionModel(): string {
  const explicit = process.env.DETECTION_MODEL?.trim()
  if (explicit) return explicit
  const vision = process.env.VISION_MODEL
  return vision && isLocalModel(vision) ? vision : FREE_TASK_GEMINI_MODEL
}

export function isLocalModelConfigured(): boolean {
  return isModelServerConfigured('chat')
}

/**
 * POST {baseUrl}/chat/completions under the chat server's in-flight limit
 * (OPENAI_COMPAT_MAX_CONCURRENCY). Bearer only when a key is set. Throws on
 * non-2xx. The response body holds the slot until it's read, so a stream
 * keeps its slot for as long as the server is generating.
 */
export async function localChatCompletion(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return serverFetch('chat', '/chat/completions', { body, signal })
}

/** Parse a non-streamed JSON body, refusing anything over LOCAL_MAX_RESPONSE_BYTES. */
export async function readLocalJson(res: Response): Promise<unknown> {
  return readJsonCapped(res, LOCAL_MAX_RESPONSE_BYTES, 'Local model')
}

/** GET {baseUrl}/models → model ids. Used by the admin Test connection route. */
export async function listLocalModels(): Promise<string[]> {
  const config = localModelConfig()
  const res = await serverFetch('chat', '/models', { timeoutMs: Math.min(config.timeoutMs, 15_000) })
  const json = await readLocalJson(res) as { data?: Array<{ id?: unknown }> }
  return (json.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string')
}
