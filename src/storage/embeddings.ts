import { db } from '../db/client.js'
import { embeddings, queryEmbeddings } from '../db/schema.js'
import { eq, and } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { createHash, randomBytes } from 'crypto'

export function isMockEmbeddings(): boolean {
  return process.env.MOCK_EMBEDDINGS === 'true'
}

/**
 * Generate a deterministic pseudo-random Float32Array vector from an input.
 * Hashes the input → uses hash bytes to seed a simple PRNG → produces a
 * vector of the requested dimension, L2-normalised.
 *
 * Same input always produces the same vector; different inputs produce
 * vectors that are approximately orthogonal in expectation.
 */
export function mockEmbeddingVector(input: Buffer | string, dim: number): Float32Array {
  const hash = createHash('sha256').update(input).digest()
  const vec = new Float32Array(dim)

  // Simple xorshift64* seeded from first 8 bytes of hash
  let state = BigInt.asUintN(64, hash.readBigUInt64BE(0)) | 1n
  let pos = 0

  function nextU32(): number {
    state ^= state >> 12n
    state ^= state << 25n
    state ^= state >> 27n
    const val = Number(BigInt.asUintN(32, (state * 0x2545F4914F6CDD1Dn) >> 32n))
    // Re-seed periodically from remaining hash bytes
    pos = (pos + 1) % (hash.length - 8)
    state ^= BigInt(hash.readUInt8(pos + 8))
    return val
  }

  for (let i = 0; i < dim; i++) {
    vec[i] = (nextU32() / 0xFFFFFFFF) * 2 - 1
  }

  return l2Normalize(vec)
}

export type EmbedLevel = 'item' | 'outfit' | 'collection' | 'share' | 'user_profile'
export type EmbedVariant = 'main' | 'centroid' | 'metadata' | 'image' | 'image_cover' | 'image_centroid' | 'image_snapshot'

// Single source of truth for embedding-model identity.
// model_version stored on every row must describe what actually produced it,
// so V2 swaps are detectable in mixed-vintage tables. ai/embed*.ts read these.
// TODO: If Vertex ever changes multimodalembedding dim from 1408, existing cached embeddings become incompatible — full re-embed required.
export const IMAGE_EMBED_MODEL = process.env.IMAGE_EMBED_MODEL ?? 'multimodalembedding@001'
export const IMAGE_EMBED_DIM = Number(process.env.IMAGE_EMBED_DIM ?? 1408)
export const IMAGE_EMBED_MODEL_VERSION = `${IMAGE_EMBED_MODEL}@${IMAGE_EMBED_DIM}`

export const TEXT_EMBED_MODEL = process.env.TEXT_EMBED_MODEL ?? 'gemini-embedding-001'
export const TEXT_EMBED_DIM = Number(process.env.TEXT_EMBED_DIM ?? 1024)
export const TEXT_EMBED_MODEL_VERSION = `${TEXT_EMBED_MODEL}@${TEXT_EMBED_DIM}`

export const IMAGE_VARIANTS: ReadonlySet<EmbedVariant> = new Set(['image', 'image_cover', 'image_centroid', 'image_snapshot'])

/**
 * The model version a variant's vectors must carry to be usable today. Reads
 * filter on it: after a model or dimension switch (#353), rows written by the
 * previous model stay in the table until pruned, and comparing a query vector
 * against them would mix two vector spaces (even two dimensions).
 */
export function modelVersionForVariant(variant: EmbedVariant): string {
  return IMAGE_VARIANTS.has(variant) ? IMAGE_EMBED_MODEL_VERSION : TEXT_EMBED_MODEL_VERSION
}

export interface EmbeddingRecord {
  level: EmbedLevel
  refId: string
  userId: string
  variant: EmbedVariant
  modelVersion: string
  vector: Float32Array
  sourceBlob: string
}

// Embedding rows are wardrobe-derived personal data. Identity must come from
// the authenticated caller — a 'self' default would silently pool every
// deployment's users into one tenant.
function requireEmbeddingUserId(userId: string): string {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Authenticated userId is required for embedding access')
  }
  return userId
}

function serializeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength))
}

function deserializeVector(buf: Buffer): Float32Array {
  const aligned = Buffer.from(buf)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4)
}

export async function saveEmbedding(rec: EmbeddingRecord): Promise<void> {
  const now = Date.now()
  const userId = requireEmbeddingUserId(rec.userId)

  const existing = db.select({ id: embeddings.id })
    .from(embeddings)
    .where(and(
      eq(embeddings.level, rec.level),
      eq(embeddings.refId, rec.refId),
      eq(embeddings.userId, userId),
      eq(embeddings.variant, rec.variant),
      eq(embeddings.modelVersion, rec.modelVersion),
    ))
    .get()

  const vectorBuf = serializeVector(rec.vector)

  if (existing) {
    db.update(embeddings)
      .set({ vector: vectorBuf, sourceBlob: rec.sourceBlob, createdAt: now })
      .where(eq(embeddings.id, existing.id))
      .run()
  } else {
    db.insert(embeddings).values({
      id: nanoid(),
      level: rec.level,
      refId: rec.refId,
      userId,
      variant: rec.variant,
      modelVersion: rec.modelVersion,
      vector: vectorBuf,
      sourceBlob: rec.sourceBlob,
      createdAt: now,
    }).run()
  }
}

export function getEmbedding(
  level: EmbedLevel,
  refId: string,
  userId: string,
  variant: EmbedVariant = 'main',
): Float32Array | null {
  requireEmbeddingUserId(userId)
  const row = db.select({ vector: embeddings.vector })
    .from(embeddings)
    .where(and(
      eq(embeddings.level, level),
      eq(embeddings.refId, refId),
      eq(embeddings.userId, userId),
      eq(embeddings.variant, variant),
      eq(embeddings.modelVersion, modelVersionForVariant(variant)),
    ))
    .get()

  if (!row) return null
  return deserializeVector(row.vector as Buffer)
}

export function getAllEmbeddings(
  userId: string,
  level: EmbedLevel,
  variant?: EmbedVariant,
): Map<string, Float32Array> {
  requireEmbeddingUserId(userId)
  const conditions = [
    eq(embeddings.userId, userId),
    eq(embeddings.level, level),
  ]
  if (variant) {
    conditions.push(eq(embeddings.variant, variant))
  }

  const rows = db.select({ refId: embeddings.refId, vector: embeddings.vector, variant: embeddings.variant, modelVersion: embeddings.modelVersion })
    .from(embeddings)
    .where(and(...conditions))
    .all()

  const result = new Map<string, Float32Array>()
  for (const row of rows) {
    if (row.modelVersion !== modelVersionForVariant(row.variant as EmbedVariant)) continue // superseded model
    result.set(row.refId, deserializeVector(row.vector as Buffer))
  }
  return result
}

export function deleteEmbedding(level: EmbedLevel, refId: string, userId: string): void {
  requireEmbeddingUserId(userId)
  db.delete(embeddings)
    .where(and(
      eq(embeddings.level, level),
      eq(embeddings.refId, refId),
      eq(embeddings.userId, userId),
    ))
    .run()
}

export function deleteEmbeddingVariant(
  level: EmbedLevel,
  refId: string,
  variant: EmbedVariant,
  userId: string,
): void {
  requireEmbeddingUserId(userId)
  db.delete(embeddings)
    .where(and(
      eq(embeddings.level, level),
      eq(embeddings.refId, refId),
      eq(embeddings.userId, userId),
      eq(embeddings.variant, variant),
    ))
    .run()
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function topK(
  query: Float32Array,
  candidates: Map<string, Float32Array>,
  k: number,
): string[] {
  const scored = Array.from(candidates.entries()).map(([id, vec]) => ({
    id,
    score: cosineSim(query, vec),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(s => s.id)
}

export function centroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error('Cannot compute centroid of empty set')
  const dim = vectors[0].length
  const result = new Float32Array(dim)
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      result[i] += vec[i]
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= vectors.length
  }
  return l2Normalize(result)
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i]
  }
  norm = Math.sqrt(norm)
  if (norm === 0) return new Float32Array(vec)
  const result = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / norm
  }
  return result
}

export function reciprocalRankFusion(
  textRanks: Map<string, number>,
  imageRanks: Map<string, number>,
  k: number,
  c = 60,
): Map<string, number> {
  const scores = new Map<string, number>()
  const allIds = new Set([...textRanks.keys(), ...imageRanks.keys()])

  for (const id of allIds) {
    let score = 0
    if (textRanks.has(id)) {
      score += 1 / (c + (textRanks.get(id) ?? 0) + 1)
    }
    if (imageRanks.has(id)) {
      score += 1 / (c + (imageRanks.get(id) ?? 0) + 1)
    }
    scores.set(id, score)
  }

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)

  return new Map(sorted)
}

export function getRrfRanks(
  candidates: Map<string, Float32Array>,
  queryVec: Float32Array,
): Map<string, number> {
  const scored = Array.from(candidates.entries()).map(([id, vec]) => ({
    id,
    score: cosineSim(queryVec, vec),
  }))
  scored.sort((a, b) => b.score - a.score)
  const ranks = new Map<string, number>()
  scored.forEach((s, i) => ranks.set(s.id, i))
  return ranks
}

export async function getOrEmbedQuery(
  text: string,
  modelVersion: string,
  embedFn: (text: string) => Promise<Float32Array>,
  userId: string,
): Promise<Float32Array> {
  requireEmbeddingUserId(userId)
  // Hash covers the tenant, so an identical query by another user can neither
  // hit nor poison this row. The plaintext query itself is never stored.
  const hash = createHash('sha256')
    .update(JSON.stringify([userId, text, modelVersion]))
    .digest('hex')

  const cached = db.select({ vector: queryEmbeddings.vector })
    .from(queryEmbeddings)
    .where(and(eq(queryEmbeddings.queryHash, hash), eq(queryEmbeddings.userId, userId)))
    .get()

  if (cached) {
    db.update(queryEmbeddings)
      .set({ lastUsedAt: Date.now() })
      .where(and(eq(queryEmbeddings.queryHash, hash), eq(queryEmbeddings.userId, userId)))
      .run()
    return deserializeVector(cached.vector as Buffer)
  }

  const vec = await embedFn(text)
  const now = Date.now()

  db.insert(queryEmbeddings).values({
    queryHash: hash,
    userId,
    modelVersion,
    vector: serializeVector(vec),
    createdAt: now,
    lastUsedAt: now,
  }).onConflictDoUpdate({
    target: [queryEmbeddings.userId, queryEmbeddings.queryHash],
    set: { vector: serializeVector(vec), modelVersion, lastUsedAt: now },
  }).run()

  return vec
}

// ─── Retrieval strategies ─────────────────────────────────────────────────────

const PRE_FILTER_SHORTLIST_K = 12
const PRE_FILTER_FALLBACK_THRESHOLD = 24

export async function topKText(
  queryText: string,
  embedFn: (text: string) => Promise<Float32Array>,
  userId: string,
  level: EmbedLevel = 'item',
  variant: EmbedVariant = 'main',
  k = PRE_FILTER_SHORTLIST_K,
): Promise<string[]> {
  const candidates = getAllEmbeddings(userId, level, variant)
  if (candidates.size === 0) return []

  const queryVec = await getOrEmbedQuery(queryText, TEXT_EMBED_MODEL_VERSION, embedFn, userId)
  return topK(queryVec, candidates, k)
}

/** topKText variant that returns cosine scores so callers can gate by similarity. */
export async function topKTextWithScores(
  queryText: string,
  embedFn: (text: string) => Promise<Float32Array>,
  userId: string,
  level: EmbedLevel = 'item',
  variant: EmbedVariant = 'main',
  k = PRE_FILTER_SHORTLIST_K,
): Promise<Array<{ id: string; score: number }>> {
  const candidates = getAllEmbeddings(userId, level, variant)
  if (candidates.size === 0) return []

  const queryVec = await getOrEmbedQuery(queryText, TEXT_EMBED_MODEL_VERSION, embedFn, userId)
  const scored = Array.from(candidates.entries()).map(([id, vec]) => ({
    id,
    score: cosineSim(queryVec, vec),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

export async function topKImage(
  queryImageUri: string,
  imageEmbedFn: (imageUri: string, userId: string) => Promise<Float32Array>,
  userId: string,
  k = PRE_FILTER_SHORTLIST_K,
): Promise<string[]> {
  const candidates = getAllEmbeddings(userId, 'item', 'image')
  if (candidates.size === 0) return []
  const queryVec = await imageEmbedFn(queryImageUri, userId)
  return topK(queryVec, candidates, k)
}

// Buffer variant for callers holding raw image bytes (e.g. discover's image
// upload mode) — avoids round-tripping through a temp file just to get a URI.
export async function topKImageFromBuffer(
  buffer: Buffer,
  imageEmbedFn: (buffer: Buffer) => Promise<Float32Array>,
  userId: string,
  k = PRE_FILTER_SHORTLIST_K,
): Promise<string[]> {
  const candidates = getAllEmbeddings(userId, 'item', 'image')
  if (candidates.size === 0) return []
  const queryVec = await imageEmbedFn(buffer)
  return topK(queryVec, candidates, k)
}

export async function topKHybrid(
  queryText: string,
  textEmbedFn: (text: string) => Promise<Float32Array>,
  queryImageUri: string | undefined,
  imageEmbedFn: (imageUri: string, userId: string) => Promise<Float32Array>,
  userId: string,
  k = PRE_FILTER_SHORTLIST_K,
): Promise<string[]> {
  const idsToRanks = (ids: string[]) => {
    const ranks = new Map<string, number>()
    ids.forEach((id, i) => ranks.set(id, i))
    return ranks
  }

  const [textRanks, imageRanks] = await Promise.all([
    topKText(queryText, textEmbedFn, userId, 'item', 'main', k * 2).then(idsToRanks),
    queryImageUri
      ? topKImage(queryImageUri, imageEmbedFn, userId, k * 2).then(idsToRanks)
      : Promise.resolve(new Map<string, number>()),
  ])

  const fused = reciprocalRankFusion(textRanks, imageRanks, k)
  return [...fused.keys()]
}

export function shouldUsePreFilter(totalItems: number): boolean {
  return totalItems >= PRE_FILTER_FALLBACK_THRESHOLD
}
