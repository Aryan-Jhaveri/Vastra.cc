// #353 — embeddings on the operator's own server through the OpenAI contract:
// POST {EMBED_BASE_URL}/embeddings. Built for Qwen3-VL-Embedding-2B on vLLM:
//
//   vllm serve Qwen/Qwen3-VL-Embedding-2B --runner pooling --port 8002
//
// Selected by a `local/` TEXT_EMBED_MODEL / IMAGE_EMBED_MODEL. Qwen3-VL-
// Embedding puts text and images in one space, so both can point at the same
// model (and the same dimension) — that's what later lets Discover match a
// text query against item photos.
//
// Request shape (vLLM pooling docs): multimodal embedding models take chat
// `messages` with an instruction, not a bare `input`. EMBED_REQUEST=input
// switches text to the plain OpenAI `{ input }` form for servers that only
// accept that (e.g. Ollama); images need `messages`.
//
// Dimensions: the model is Matryoshka-trained, so the first N values of its
// full vector are a valid N-dim embedding. vLLM's `dimensions` parameter
// isn't documented for multimodal models, so the full vector is requested and
// truncated + re-normalised here to TEXT_EMBED_DIM / IMAGE_EMBED_DIM.

import { localModelName } from './localModel.js'
import { readJsonCapped, serverFetch } from './modelServers.js'
import { l2Normalize } from '../storage/embeddings.js'

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
export const DEFAULT_EMBED_INSTRUCTION = "Represent the user's input."

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export interface LocalEmbedding {
  vector: Float32Array
  /** Tokens the server counted, when it reports usage. */
  tokens: number
}

function instruction(): string {
  return process.env.EMBED_INSTRUCTION?.trim() || DEFAULT_EMBED_INSTRUCTION
}

function requestFormat(): 'messages' | 'input' {
  return process.env.EMBED_REQUEST?.trim() === 'input' ? 'input' : 'messages'
}

function imageMime(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

async function embed(model: string, body: Record<string, unknown>, dim: number): Promise<LocalEmbedding> {
  const res = await serverFetch('embed', '/embeddings', { body: { model: localModelName(model), encoding_format: 'float', ...body } })
  const json = await readJsonCapped(res, MAX_RESPONSE_BYTES, 'Embedding server') as {
    data?: Array<{ embedding?: unknown }>
    usage?: { prompt_tokens?: unknown }
  }
  const values = json.data?.[0]?.embedding
  if (!Array.isArray(values) || values.length === 0 || !values.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Embedding server returned no embedding (expected data[0].embedding as numbers)')
  }
  if (values.length < dim) {
    throw new Error(`Embedding server returned ${values.length} dimensions; the configured dimension is ${dim}. Lower the *_EMBED_DIM setting.`)
  }
  const tokens = typeof json.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : 0
  return { vector: l2Normalize(Float32Array.from(values.slice(0, dim) as number[])), tokens }
}

function messages(content: Part[]): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: [{ type: 'text', text: instruction() }] },
      { role: 'user', content },
    ],
  }
}

export async function localEmbedText(text: string, model: string, dim: number): Promise<LocalEmbedding> {
  if (requestFormat() === 'input') return embed(model, { input: text }, dim)
  return embed(model, messages([{ type: 'text', text }]), dim)
}

export async function localEmbedImage(buffer: Buffer, model: string, dim: number): Promise<LocalEmbedding> {
  if (requestFormat() === 'input') {
    throw new Error('EMBED_REQUEST=input cannot embed images; image embeddings need a server that accepts chat messages (vLLM --runner pooling)')
  }
  const url = `data:${imageMime(buffer)};base64,${buffer.toString('base64')}`
  return embed(model, messages([{ type: 'image_url', image_url: { url } }]), dim)
}
