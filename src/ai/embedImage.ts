import { GoogleAuth } from 'google-auth-library'
import { readFile } from 'fs/promises'
import { resolveImagePath } from '../storage/images.js'
import { isLocalModel } from './localModel.js'
import { localEmbedImage } from './localEmbed.js'
import {
  IMAGE_EMBED_MODEL,
  IMAGE_EMBED_DIM,
  IMAGE_EMBED_MODEL_VERSION,
  saveEmbedding,
  deleteEmbedding,
  getEmbedding,
  centroid,
  isMockEmbeddings,
  mockEmbeddingVector,
} from '../storage/embeddings.js'

// multimodalembedding@001 is a Vertex Prediction-API model, not a GenAI model —
// the @google/genai SDK's `embedContent` call posts to `:embedContent`, but this
// model only serves `:predict` (returning 400 "Empty instances." otherwise).
// So we hit the predict REST endpoint directly with an ADC bearer token.
let authClient: GoogleAuth | null = null
function getAuth(): GoogleAuth {
  if (!authClient) {
    authClient = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  }
  return authClient
}

export async function embedImage(buffer: Buffer): Promise<Float32Array> {
  if (isMockEmbeddings()) {
    console.log('[MOCK] embedImage')
    return mockEmbeddingVector(buffer, IMAGE_EMBED_DIM)
  }
  if (isLocalModel(IMAGE_EMBED_MODEL)) {
    return (await localEmbedImage(buffer, IMAGE_EMBED_MODEL, IMAGE_EMBED_DIM)).vector
  }

  const project = process.env.GCP_PROJECT_ID ?? ''
  const location = process.env.GCP_LOCATION ?? 'us-central1'
  if (!project) {
    throw new Error('GCP_PROJECT_ID not set — multimodalembedding@001 is Vertex-only and has no Developer-API equivalent')
  }

  const accessToken = await getAuth().getAccessToken()
  if (!accessToken) throw new Error('Failed to obtain GCP access token for Vertex predict call')

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${IMAGE_EMBED_MODEL}:predict`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ image: { bytesBase64Encoded: buffer.toString('base64') } }],
      parameters: { dimension: IMAGE_EMBED_DIM },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Vertex predict HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = await res.json() as { predictions?: Array<{ imageEmbedding?: number[] }> }
  const values = json.predictions?.[0]?.imageEmbedding
  if (!values || values.length === 0) {
    throw new Error(`Empty imageEmbedding in predict response from ${IMAGE_EMBED_MODEL}`)
  }
  return new Float32Array(values)
}

export async function embedImageBatch(buffers: Buffer[]): Promise<Float32Array[]> {
  const results: Float32Array[] = []
  for (const buffer of buffers) {
    results.push(await embedImage(buffer))
  }
  return results
}

export async function embedItemImage(imageUri: string, userId: string): Promise<Float32Array> {
  const absPath = resolveImagePath(imageUri, userId)
  const buffer = await readFile(absPath)
  return embedImage(buffer)
}

export function itemSourceBlob(item: {
  category?: string | null
  subcategory?: string | null
  colors?: string | null
  primaryColor?: string | null
  material?: string | null
  brand?: string | null
  size?: string | null
  season?: string | null
  tags?: string | null
  aiDescription?: string | null
  occasion?: string | null
  wearContext?: string | null
}): string {
  return [
    item.category ?? '',
    item.subcategory ?? '',
    item.primaryColor ?? '',
    item.colors ?? '',
    item.material ?? '',
    item.brand ?? '',
    item.size ?? '',
    item.season ?? '',
    item.tags ?? '',
    item.aiDescription ?? '',
    item.occasion ?? '',
    item.wearContext ?? '',
  ].join(' | ')
}

export function outfitMetadataSourceBlob(outfit: {
  name?: string | null
  occasion?: string | null
  season?: string | null
  notes?: string | null
  tags?: string | null
}): string {
  return [
    outfit.name ?? '',
    outfit.occasion ?? '',
    outfit.season ?? '',
    outfit.notes ?? '',
    outfit.tags ?? '',
  ].join(' | ')
}

// ─── Lifecycle helpers (called by routes) ──────────────────────────────────────

function isEnabled(): boolean {
  return process.env.IMAGE_EMBED_ENABLED === 'true' || process.env.IMAGE_EMBED_ENABLED === '1'
}

function warn(err: unknown, context: string): void {
  console.warn(`[embed] ${context}:`, (err as Error).message ?? String(err))
}

export async function embedItemOnSave(item: {
  id: string
  imageUri: string
  category?: string | null
  subcategory?: string | null
  colors?: string | null
  primaryColor?: string | null
  material?: string | null
  brand?: string | null
  size?: string | null
  season?: string | null
  tags?: string | null
  aiDescription?: string | null
  occasion?: string | null
  wearContext?: string | null
}, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    const vec = await embedItemImage(item.imageUri, userId)
    await saveEmbedding({
      level: 'item',
      refId: item.id,
      userId,
      variant: 'image',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: itemSourceBlob(item),
    })
  } catch (err) {
    warn(err, `item image embed failed for ${item.id}`)
  }
}

export async function embedOutfitCoverOnSave(outfit: {
  id: string
  coverImageUri: string | null
  name?: string | null
  occasion?: string | null
  season?: string | null
  notes?: string | null
  tags?: string | null
}, userId: string): Promise<void> {
  if (!isEnabled()) return
  if (!outfit.coverImageUri) return
  try {
    const vec = await embedItemImage(outfit.coverImageUri, userId)
    await saveEmbedding({
      level: 'outfit',
      refId: outfit.id,
      userId,
      variant: 'image_cover',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: outfitMetadataSourceBlob(outfit),
    })
  } catch (err) {
    warn(err, `outfit cover embed failed for ${outfit.id}`)
  }
}

export async function embedOutfitCentroidOnSave(outfit: {
  id: string
  itemIds: string
}, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    const ids: string[] = JSON.parse(outfit.itemIds)
    const vecs: Float32Array[] = []
    for (const itemId of ids) {
      const vec = getEmbedding('item', itemId, userId, 'image')
      if (vec) vecs.push(vec)
    }
    if (vecs.length === 0) return

    const meanVec = centroid(vecs)
    await saveEmbedding({
      level: 'outfit',
      refId: outfit.id,
      userId,
      variant: 'image_centroid',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: meanVec,
      sourceBlob: ids.join(','),
    })
  } catch (err) {
    warn(err, `outfit centroid embed failed for ${outfit.id}`)
  }
}

export async function embedShareImageOnSave(share: {
  id: string
  description: string
  imageUris: string
}, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    const uris: string[] = JSON.parse(share.imageUris)
    const firstUri = uris[0]
    if (!firstUri) return

    const vec = await embedItemImage(firstUri, userId)
    await saveEmbedding({
      level: 'share',
      refId: share.id,
      userId,
      variant: 'image_snapshot',
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: share.description,
    })
  } catch (err) {
    warn(err, `share image embed failed for ${share.id}`)
  }
}

export async function deleteEmbeddingsForItem(itemId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('item', itemId, userId)
  } catch (err) {
    warn(err, `delete embeddings failed for item ${itemId}`)
  }
}

export async function deleteEmbeddingsForOutfit(outfitId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('outfit', outfitId, userId)
  } catch (err) {
    warn(err, `delete embeddings failed for outfit ${outfitId}`)
  }
}

export async function deleteEmbeddingsForShare(shareId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('share', shareId, userId)
  } catch (err) {
    warn(err, `delete embeddings failed for share ${shareId}`)
  }
}
