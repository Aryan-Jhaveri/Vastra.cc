import { apiFetchJSONRateAware } from '../lib/rateLimitRetry'
import { apiFetch } from './client'
import type { Detection } from '../components/DetectionOverlay'

export interface DetectResponse {
  sourceUri: string
  detections: Detection[]
  cost?: {
    billedTokens: number
    wholesaleCostCentsX100: number
    tokensIn: number
    tokensOut: number
  }
}

export async function detectBulkItems(file: File): Promise<DetectResponse> {
  const form = new FormData()
  form.append('image', file)
  return apiFetchJSONRateAware<DetectResponse>('/api/items/bulk-detect', {
    method: 'POST',
    body: form,
  })
}

/**
 * One detected box cropped on the server from the source photo bulk-detect
 * saved. The browser canvas crop failed silently for some users (prod
 * 2026-09-29: empty previews, nothing classified or saved).
 */
export async function cropDetectedBox(sourceUri: string, box: Detection['box']): Promise<File> {
  const res = await apiFetch('/api/items/crop', { method: 'POST', body: JSON.stringify({ sourceUri, box }) })
  if (!res.ok) throw new Error(`crop failed (${res.status})`)
  const blob = await res.blob()
  if (!blob.size) throw new Error('crop failed (empty)')
  return new File([blob], 'crop.jpg', { type: 'image/jpeg' })
}

/** Stage a photo on the server without detection (hand-drawn boxes) → its sourceUri. */
export async function stageSourcePhoto(file: File): Promise<string> {
  const form = new FormData()
  form.append('image', file)
  const res = await apiFetch('/api/items/source', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`stage failed (${res.status})`)
  const body = await res.json() as { sourceUri?: string }
  if (!body.sourceUri) throw new Error('stage failed (no sourceUri)')
  return body.sourceUri
}
