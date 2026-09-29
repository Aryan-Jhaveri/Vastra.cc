import { GoogleGenAI } from '@google/genai'
import { parseAIJSON } from './parse.js'
import { messageEvents } from './messageAdapters.js'
import { isLocalModel, localChatCompletion, localModelName, readLocalJson } from './localModel.js'
import { ModelCallError, type MessageRequest, type MessageResponse, type ModelEvent } from './messages.js'

/** Returns true when the error is a transient model-overload (HTTP 503 / UNAVAILABLE). */
export function isModelBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as Record<string, unknown>).status === 503) return true
  const msg = String((err as Record<string, unknown>).message ?? '')
  return msg.includes('"code":503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('overloaded')
}

/**
 * Run `fn`, retrying on model-busy (503) errors with exponential back-off.
 * Logs a clean one-liner on each retry; throws on the final attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, delayMs = 2000, label = '[AI]' } = {},
): Promise<T> {
  let delay = delayMs
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (isModelBusy(err) && attempt < maxAttempts) {
        console.warn(`${label} Model busy (503) — retrying in ${delay / 1000}s (attempt ${attempt}/${maxAttempts})`)
        await new Promise(r => setTimeout(r, delay))
        delay *= 2
        continue
      }
      throw err
    }
  }
  /* istanbul ignore next */
  throw new Error('unreachable')
}

const geminiApiKey = process.env.GEMINI_API_KEY ?? ''
const gcpProjectId = process.env.GCP_PROJECT_ID ?? ''
const gcpLocation = process.env.GCP_LOCATION ?? 'us-central1'
// Gemini image-gen models on Vertex are only served from the "global" endpoint, not regional ones.
const gcpImageGenLocation = process.env.GCP_IMAGE_GEN_LOCATION ?? 'global'

if (!geminiApiKey && !gcpProjectId) {
  console.warn('[closet] GEMINI_API_KEY is not set — AI features will fail at runtime')
}

const openrouterDisabled = process.env.OPENROUTER_DISABLED === 'true'
if (openrouterDisabled) {
  console.warn('[closet] OPENROUTER_DISABLED=true — all OpenRouter calls rerouted to Vertex Gemini')
}

const developerFallback = () => {
  if (geminiApiKey) {
    console.warn('[closet] GCP_PROJECT_ID is not set — falling back to Developer API (personal billing) for all AI calls')
  }
  return new GoogleGenAI({ apiKey: geminiApiKey })
}

export const vertexAi = gcpProjectId
  ? new GoogleGenAI({ vertexai: true, project: gcpProjectId, location: gcpLocation })
  : developerFallback()

export const vertexAiImageGen = gcpProjectId
  ? new GoogleGenAI({ vertexai: true, project: gcpProjectId, location: gcpImageGenLocation })
  : vertexAi

export const ai = vertexAi

// Image generation must stay on a Gemini image-gen model (not flash).
export const VISION_MODEL = process.env.VISION_MODEL ?? 'gemini-2.5-flash'
export const TEXT_MODEL = process.env.TEXT_MODEL ?? 'gemini-2.5-flash'
export const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL ?? 'gemini-2.5-flash-image'
export const IMAGE_GEN_MODEL_LITE = process.env.IMAGE_GEN_MODEL_LITE ?? 'gemini-3.1-flash-lite-image'
export const IMAGE_GEN_MODEL_PRO  = process.env.IMAGE_GEN_MODEL_PRO  ?? 'gemini-3-pro-image'

// ─── Usage tracking ─────────────────────────────────────────────────────────────

export interface UsageMetadata {
  tokensIn: number
  tokensOut: number
}

const USAGE_WARNED = new Set<string>()

// ─── Provider routing helpers ─────────────────────────────────────────────────

const MASTER_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? ''

function isOpenRouterModel(modelId: string): boolean {
  return modelId.includes('/') && !isLocalModel(modelId)
}

/**
 * Billing/analytics provider label for a model, mirroring how the call is
 * actually routed: OpenRouter for "vendor/model" ids (routed by id shape —
 * per-user keys from #166 handle auth), Vertex when GCP_PROJECT_ID is set,
 * else the Developer-API (Gemini) local-dev fallback. `local/<name>` ids go to
 * the operator's own OpenAI-compatible server (#289) and are labelled 'self'. instrumented.ts
 * overrides this to 'mocked' when MOCK_* flags are on. Keeps ai_calls.provider
 * honest after #158 (Vertex) and #143 (OpenRouter + mocks).
 *
 * IMPORTANT: GCP_PROJECT_ID is captured at module-load time (see the
 * `gcpProjectId` constant above), so tests that vary it MUST use
 * vi.resetModules() + dynamic import to reload the module with fresh env
 * bindings. See test/ai/providerForModel.test.ts.
 */
export function providerForModel(modelId: string): 'openrouter' | 'vertex' | 'gemini' | 'self' {
  if (isLocalModel(modelId)) return 'self'
  if (isOpenRouterModel(modelId)) return 'openrouter'
  return gcpProjectId ? 'vertex' : 'gemini'
}

/**
 * Build an OpenAI-compatible chat completions request for OpenRouter.
 */
async function openRouterChat(messages: Array<{ role: string; content: unknown }>, model: string, bearerKey: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`), { status: res.status })
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty response from OpenRouter')
  return content
}

async function openRouterChatWithUsage(messages: Array<{ role: string; content: unknown }>, model: string, bearerKey: string): Promise<{ text: string; usage: UsageMetadata }> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`), { status: res.status })
  }

  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const content = json.choices?.[0]?.message?.content

  const usage: UsageMetadata = {
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
  }
  if (!content) throw new ModelCallError(new Error('Empty response from OpenRouter'), usage)
  const warnKey = `openrouter:${model}`
  if (!json.usage && !USAGE_WARNED.has(warnKey)) {
    USAGE_WARNED.add(warnKey)
    console.warn(`[billing] no usage metadata in OpenRouter response for "${model}" — defaulting tokens to 0`)
  }
  return { text: content, usage }
}

/**
 * OpenAI-compatible chat completion against the operator's own server (#289).
 * No response_format: structured-output support varies by server, so JSON
 * goes through the same prompt + parseAIJSON path as every other provider.
 */
async function localChatWithUsage(messages: Array<{ role: string; content: unknown }>, model: string): Promise<{ text: string; usage: UsageMetadata }> {
  const res = await localChatCompletion({ model: localModelName(model), messages })
  const json = await readLocalJson(res) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  const usage: UsageMetadata = {
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
  }
  const content = json.choices?.[0]?.message?.content
  if (!content) throw new ModelCallError(new Error('Empty response from local model'), usage)
  return { text: content, usage }
}

/** One JPEG (base64, no data-URI prefix) or several, in order. */
export type ImageInput = string | string[]

function imageList(images?: ImageInput): string[] {
  if (!images) return []
  return (Array.isArray(images) ? images : [images]).filter(Boolean)
}

function openAIUserContent(prompt: string, images?: ImageInput): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
  for (const image of imageList(images)) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${image}` },
    })
  }
  return content
}

function geminiParts(prompt: string, images?: ImageInput): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = imageList(images).map(data => ({ inlineData: { mimeType: 'image/jpeg', data } }))
  parts.push({ text: prompt })
  return parts
}

/**
 * Build a Gemini parts array and call the Gemini SDK.
 */
async function geminiChat(
  parts: Array<Record<string, unknown>>,
  model: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
  })
  if (!response.text) throw new Error('Empty response from Gemini')
  return response.text
}

async function geminiChatWithUsage(
  parts: Array<Record<string, unknown>>,
  model: string,
): Promise<{ text: string; usage: UsageMetadata }> {
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
  })

  const metadata = response.usageMetadata
  const usage: UsageMetadata = {
    tokensIn: metadata?.promptTokenCount ?? 0,
    tokensOut: metadata?.candidatesTokenCount ?? 0,
  }
  if (!response.text) throw new ModelCallError(new Error('Empty response from Gemini'), usage)
  const warnKey = `gemini:${model}`
  if (!metadata && !USAGE_WARNED.has(warnKey)) {
    USAGE_WARNED.add(warnKey)
    console.warn(`[billing] no usage metadata in Gemini response for "${model}" — defaulting tokens to 0`)
  }
  return { text: response.text, usage }
}

// ─── Public abstractions ──────────────────────────────────────────────────────

function resolveOpenRouterKey(bearerKey: string | undefined, model: string): string {
  if (isOpenRouterModel(model)) {
    if (bearerKey) return bearerKey
    if (MASTER_OPENROUTER_KEY) return MASTER_OPENROUTER_KEY
    throw new Error(`OpenRouter model "${model}" requires a per-user key — call via runInstrumented or pass bearerKey`)
  }
  return '' // not used for Gemini
}

/**
 * Send a text or text+image prompt to the AI provider.
 *
 * Provider routing:
 * - `local/<name>` ids go to the operator's OpenAI-compatible server (#289).
 * - Otherwise, if the model ID contains a slash (e.g. "mistralai/mistral-small-3.2"),
 *   routes through OpenRouter's OpenAI-compatible endpoint.
 * - Otherwise uses the Gemini SDK.
 *
 * OpenRouter calls require a bearerKey (per-user key or admin fallback
 * MASTER_OPENROUTER_KEY). Throws if none is available.
 *
 * @param prompt - The text prompt to send
 * @param imageBase64 - Optional JPEG image encoded as base64 (without data URI prefix)
 * @param model - Optional model override (defaults to VISION_MODEL if image provided, TEXT_MODEL otherwise)
 * @param bearerKey - Required when the model is an OpenRouter model
 */
export async function generateText(
  prompt: string,
  imageBase64?: string,
  model?: string,
  bearerKey?: string,
): Promise<string> {
  const effectiveModel = model ?? (imageBase64 ? VISION_MODEL : TEXT_MODEL)

  if (isLocalModel(effectiveModel)) {
    return (await localChatWithUsage([{ role: 'user', content: openAIUserContent(prompt, imageBase64) }], effectiveModel)).text
  }

  if (isOpenRouterModel(effectiveModel)) {
    if (openrouterDisabled) {
      const parts: Array<Record<string, unknown>> = []
      if (imageBase64) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } })
      }
      parts.push({ text: prompt })
      return geminiChat(parts, 'gemini-2.5-flash')
    }
    const key = resolveOpenRouterKey(bearerKey, effectiveModel)
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
    if (imageBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
      })
    }
    return openRouterChat([{ role: 'user', content }], effectiveModel, key)
  }

  const parts: Array<Record<string, unknown>> = []
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } })
  }
  parts.push({ text: prompt })
  return geminiChat(parts, effectiveModel)
}

export async function generateTextWithUsage(
  prompt: string,
  imageBase64?: ImageInput,
  model?: string,
  bearerKey?: string,
): Promise<{ text: string; usage: UsageMetadata }> {
  const effectiveModel = model ?? (imageList(imageBase64).length ? VISION_MODEL : TEXT_MODEL)

  if (isLocalModel(effectiveModel)) {
    return localChatWithUsage([{ role: 'user', content: openAIUserContent(prompt, imageBase64) }], effectiveModel)
  }

  if (isOpenRouterModel(effectiveModel)) {
    if (openrouterDisabled) {
      return geminiChatWithUsage(geminiParts(prompt, imageBase64), 'gemini-2.5-flash')
    }
    const key = resolveOpenRouterKey(bearerKey, effectiveModel)
    return openRouterChatWithUsage([{ role: 'user', content: openAIUserContent(prompt, imageBase64) }], effectiveModel, key)
  }

  return geminiChatWithUsage(geminiParts(prompt, imageBase64), effectiveModel)
}

/**
 * Send a prompt and parse the response as JSON.
 * Provider-agnostic — uses {@link generateText} + {@link parseAIJSON}.
 */
export async function generateJSON<T>(
  prompt: string,
  imageBase64?: string,
  model?: string,
  bearerKey?: string,
): Promise<T> {
  const text = await generateText(prompt, imageBase64, model, bearerKey)
  return parseAIJSON<T>(text)
}

export async function generateJSONWithUsage<T>(
  prompt: string,
  imageBase64?: ImageInput,
  model?: string,
  bearerKey?: string,
): Promise<{ data: T; usage: UsageMetadata }> {
  const { text, usage } = await generateTextWithUsage(prompt, imageBase64, model, bearerKey)
  try {
    return { data: parseAIJSON<T>(text), usage }
  } catch (error) {
    throw new ModelCallError(error, usage)
  }
}

/** Low-level transport only. Application code must use generateMessagesInstrumented. */
export async function generateMessages(request: MessageRequest, model = TEXT_MODEL, bearerKey?: string): Promise<MessageResponse> {
  for await (const event of modelMessageEvents(request, model, bearerKey, false)) {
    if (event.type === 'complete') return event.response
  }
  throw new Error('Model returned no completed message')
}

/** Low-level transport only. Use streamMessagesInstrumented to reserve, settle, and record usage. */
export function streamMessages(request: MessageRequest, model = TEXT_MODEL, bearerKey?: string): AsyncGenerator<ModelEvent> {
  return modelMessageEvents(request, model, bearerKey, true)
}

function modelMessageEvents(request: MessageRequest, model: string, bearerKey: string | undefined, stream: boolean): AsyncGenerator<ModelEvent> {
  // Unlike legacy single prompts, conversations cannot silently change providers:
  // provider-bound tool history and capabilities may not survive a reroute.
  if (isOpenRouterModel(model) && openrouterDisabled) throw new Error('OpenRouter message calls are disabled; provider fallback is not supported')
  return messageEvents(request, { model, gemini: ai, openrouterKey: bearerKey, stream })
}
