import { vertexAi } from './client.js'
import { isLocalModel } from './localModel.js'
import { localEmbedText } from './localEmbed.js'
import type { EmbedVariant } from '../storage/embeddings.js'
import {
  TEXT_EMBED_MODEL,
  TEXT_EMBED_DIM,
  TEXT_EMBED_MODEL_VERSION,
  saveEmbedding,
  deleteEmbedding,
  isMockEmbeddings,
  mockEmbeddingVector,
} from '../storage/embeddings.js'

// Outfit text vectors have always been written under the 'metadata' variant.
// Readers must use the same constant — requesting 'main' silently returned an
// empty candidate set, which is why related-outfit retrieval fell back.
export const OUTFIT_TEXT_VARIANT: EmbedVariant = 'metadata'

export async function embedText(text: string): Promise<Float32Array> {
  if (isMockEmbeddings()) {
    console.log('[MOCK] embedText')
    return mockEmbeddingVector(text, TEXT_EMBED_DIM)
  }
  if (isLocalModel(TEXT_EMBED_MODEL)) {
    return (await localEmbedText(text, TEXT_EMBED_MODEL, TEXT_EMBED_DIM)).vector
  }

  const response = await vertexAi.models.embedContent({
    model: TEXT_EMBED_MODEL,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: { outputDimensionality: TEXT_EMBED_DIM },
  })

  const values = response.embeddings?.[0]?.values
  if (!values || values.length === 0) {
    throw new Error(`Empty text embedding response from ${TEXT_EMBED_MODEL}`)
  }
  return new Float32Array(values)
}

export function textItemSourceBlob(item: {
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

export function textOutfitSourceBlob(outfit: {
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

// ─── Lifecycle helpers ─────────────────────────────────────────────────────────

function isEnabled(): boolean {
  return process.env.TEXT_EMBED_ENABLED === 'true' || process.env.TEXT_EMBED_ENABLED === '1'
}

function warn(err: unknown, context: string): void {
  console.warn(`[embed:text] ${context}:`, (err as Error).message ?? String(err))
}

export async function embedItemTextOnSave(item: {
  id: string
  userId: string
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
}): Promise<void> {
  if (!isEnabled()) return
  try {
    const blob = textItemSourceBlob(item)
    const vec = await embedText(blob)
    await saveEmbedding({
      level: 'item',
      refId: item.id,
      userId: item.userId,
      variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: blob,
    })
  } catch (err) {
    warn(err, `item text embed failed for ${item.id}`)
  }
}

export async function embedOutfitTextOnSave(outfit: {
  id: string
  userId: string
  name?: string | null
  occasion?: string | null
  season?: string | null
  notes?: string | null
  tags?: string | null
}): Promise<void> {
  if (!isEnabled()) return
  try {
    const blob = textOutfitSourceBlob(outfit)
    const vec = await embedText(blob)
    await saveEmbedding({
      level: 'outfit',
      refId: outfit.id,
      userId: outfit.userId,
      variant: OUTFIT_TEXT_VARIANT,
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: blob,
    })
  } catch (err) {
    warn(err, `outfit text embed failed for ${outfit.id}`)
  }
}

export async function embedShareTextOnSave(share: {
  id: string
  userId: string
  description: string
}): Promise<void> {
  if (!isEnabled()) return
  try {
    const vec = await embedText(share.description)
    await saveEmbedding({
      level: 'share',
      refId: share.id,
      userId: share.userId,
      variant: 'main',
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      vector: vec,
      sourceBlob: share.description,
    })
  } catch (err) {
    warn(err, `share text embed failed for ${share.id}`)
  }
}

export async function deleteTextEmbeddingsForItem(itemId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('item', itemId, userId)
  } catch (err) {
    warn(err, `delete text embeddings failed for item ${itemId}`)
  }
}

export async function deleteTextEmbeddingsForOutfit(outfitId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('outfit', outfitId, userId)
  } catch (err) {
    warn(err, `delete text embeddings failed for outfit ${outfitId}`)
  }
}

export async function deleteTextEmbeddingsForShare(shareId: string, userId: string): Promise<void> {
  if (!isEnabled()) return
  try {
    deleteEmbedding('share', shareId, userId)
  } catch (err) {
    warn(err, `delete text embeddings failed for share ${shareId}`)
  }
}
