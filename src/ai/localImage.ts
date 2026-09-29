// #352 — image generation on the operator's own server, through the OpenAI
// images contract: multipart POST {IMAGE_GEN_BASE_URL}/images/edits.
// Built and tested against vLLM-Omni serving Qwen-Image-2.1:
//
//   vllm serve Qwen/Qwen-Image-2.1 --omni --port 8091 --api-key "$KEY"
//
// Selected by a `local/` IMAGE_GEN_MODEL (e.g. local/Qwen/Qwen-Image-2.1);
// the prefix is stripped before sending. Try-on and Make Pretty keep their
// prompts, image order (garments first, person last) and storage path.
//
// Request (vLLM-Omni docs, serving/image_edit_api): multipart/form-data, the
// images as repeated `image` file fields, everything else as form fields.
// A JSON body resets the connection. Response: `data[0].b64_json`, plus
// `metrics.peak_memory_mb` which the #296 benchmark records.
//
// Load: the image server runs one generation at a time by default
// (IMAGE_GEN_MAX_CONCURRENCY=1, queue IMAGE_GEN_MAX_QUEUE) and each user may
// have IMAGE_GEN_MAX_PER_USER (default 1) generation in flight, so one person
// can't fill the whole queue. Nothing about the user goes on the wire.

import { isLocalModel, localModelName } from './localModel.js'
import { readJsonCapped, serverFetch } from './modelServers.js'

export const DEFAULT_IMAGE_GEN_MAX_REFS = 4
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024

/** Image model id for try-on / Make Pretty. Read per call. */
export function imageGenModel(): string {
  return process.env.IMAGE_GEN_MODEL || 'gemini-2.5-flash-image'
}

export function isLocalImageGen(model = imageGenModel()): boolean {
  return isLocalModel(model)
}

/** Reference images the local image model accepts per request (Qwen-Image-2.1: 4). */
export function imageGenMaxRefs(): number {
  const n = Number(process.env.IMAGE_GEN_MAX_REFS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_IMAGE_GEN_MAX_REFS
}

function maxPerUser(): number {
  const n = Number(process.env.IMAGE_GEN_MAX_PER_USER)
  return Number.isInteger(n) && n > 0 ? n : 1
}

/** 429: the user already has a generation running. Routes answer it as-is. */
export class ImageGenUserBusyError extends Error {
  readonly status = 429
  constructor() {
    super('You already have an image generating. Wait for it to finish, then try again.')
    this.name = 'ImageGenUserBusyError'
  }
}

/** 400: more distinct garments than the image model can take in one request. */
export class TooManyReferencesError extends Error {
  readonly status = 400
  constructor(readonly limit: number, readonly requested: number) {
    super(`This image model takes at most ${limit} garment${limit === 1 ? '' : 's'} per try-on; ${requested} were selected. Try fewer items.`)
    this.name = 'TooManyReferencesError'
  }
}

const inFlight = new Map<string, number>()

/** Test-only. */
export function __resetImageGenUsers(): void {
  inFlight.clear()
}

export interface LocalImageEditInput {
  /** The `local/…` model id. */
  model: string
  prompt: string
  /** Base64 JPEGs, in the order the prompt refers to them. */
  images: string[]
  /** Used only for the per-user in-flight cap; never sent. */
  userId: string
  /** Diffusion steps; unset uses the model default (IMAGE_GEN_STEPS overrides). */
  steps?: number
  /** Qwen's true CFG scale; unset uses the model default (IMAGE_GEN_TRUE_CFG overrides). */
  trueCfgScale?: number
  signal?: AbortSignal
}

export interface LocalImageResult {
  /** Base64 of the generated image. */
  data: string
  /** Server-reported peak GPU memory for this request, when vLLM-Omni sends it. */
  peakMemoryMb?: number
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export async function localImageEdit(input: LocalImageEditInput): Promise<LocalImageResult> {
  if (!input.images.length) throw new Error('At least one reference image is required')
  const limit = imageGenMaxRefs()
  if (input.images.length > limit) throw new TooManyReferencesError(limit, input.images.length)

  const running = inFlight.get(input.userId) ?? 0
  if (running >= maxPerUser()) throw new ImageGenUserBusyError()
  inFlight.set(input.userId, running + 1)
  try {
    const form = new FormData()
    form.append('model', localModelName(input.model))
    form.append('prompt', input.prompt)
    input.images.forEach((b64, i) => {
      form.append('image', new Blob([Buffer.from(b64, 'base64')], { type: 'image/jpeg' }), `ref-${i + 1}.jpg`)
    })
    form.append('n', '1')
    form.append('response_format', 'b64_json')
    form.append('output_format', 'jpeg')
    const size = process.env.IMAGE_GEN_SIZE?.trim()
    if (size) form.append('size', size)
    const steps = envNumber('IMAGE_GEN_STEPS') ?? input.steps
    if (steps !== undefined) form.append('num_inference_steps', String(steps))
    const cfg = envNumber('IMAGE_GEN_TRUE_CFG') ?? input.trueCfgScale
    if (cfg !== undefined) form.append('true_cfg_scale', String(cfg))
    const seed = envNumber('IMAGE_GEN_SEED')
    if (seed !== undefined) form.append('seed', String(seed))

    const res = await serverFetch('image', '/images/edits', { body: form, signal: input.signal })
    const json = await readJsonCapped(res, MAX_RESPONSE_BYTES, 'Image server') as {
      data?: Array<{ b64_json?: unknown }>
      metrics?: { peak_memory_mb?: unknown }
    }
    const data = json.data?.[0]?.b64_json
    if (typeof data !== 'string' || !data) throw new Error('Image server returned no image (expected data[0].b64_json)')
    const peak = json.metrics?.peak_memory_mb
    return { data, ...(typeof peak === 'number' ? { peakMemoryMb: peak } : {}) }
  } finally {
    const left = (inFlight.get(input.userId) ?? 1) - 1
    if (left > 0) inFlight.set(input.userId, left)
    else inFlight.delete(input.userId)
  }
}

/**
 * Pick try-on reference images under the model's limit. Each group is one
 * garment's views, best first (an item's primary view leads). Every garment
 * gets its first view before any garment gets a second one, so extra views
 * are what gets dropped. More garments than slots is an error rather than a
 * silently missing garment.
 */
export function selectGarmentViews<T>(groups: T[][], slots: number): { selected: T[]; droppedViews: number } {
  const garments = groups.filter(g => g.length > 0)
  if (garments.length > slots) throw new TooManyReferencesError(slots, garments.length)
  const picked: T[][] = garments.map(g => [g[0]])
  let used = garments.length
  for (let depth = 1; used < slots; depth++) {
    let added = false
    for (let i = 0; i < garments.length && used < slots; i++) {
      if (garments[i][depth] !== undefined) { picked[i].push(garments[i][depth]); used++; added = true }
    }
    if (!added) break
  }
  const total = garments.reduce((n, g) => n + g.length, 0)
  return { selected: picked.flat(), droppedViews: total - used }
}
