import { db } from '../db/client.js'
import { items, outfits, sharePayloads, embeddings } from '../db/schema.js'
import { eq, and, gt, asc } from 'drizzle-orm'
import { embedText, textItemSourceBlob, textOutfitSourceBlob, OUTFIT_TEXT_VARIANT } from './embed.js'
import { requireUserId } from '../db/queries.js'
import { embedItemImage } from './embedImage.js'
import { saveEmbedding, type EmbedVariant, TEXT_EMBED_MODEL_VERSION, IMAGE_EMBED_MODEL_VERSION, TEXT_EMBED_MODEL, IMAGE_EMBED_MODEL } from '../storage/embeddings.js'
import { isLocalModel } from './localModel.js'
import { runInstrumented } from './instrumented.js'
import type { AiTask } from '../cost/tokenTable.js'

// ai_calls labels must name the model that actually produced the vector:
// the operator's own server for local/ models (#353), else the Google API.
function embedProvider(model: string, google: 'gemini' | 'vertex'): 'self' | 'gemini' | 'vertex' {
  return isLocalModel(model) ? 'self' : google
}

function isEnabled(): boolean {
  return process.env.TEXT_EMBED_ENABLED === 'true' || process.env.TEXT_EMBED_ENABLED === '1'
}

function alreadyEmbedded(level: 'item' | 'outfit' | 'share', refId: string, variant: 'main' | 'metadata'): boolean {
  const row = db.select({ id: embeddings.id })
    .from(embeddings)
    .where(and(
      eq(embeddings.level, level),
      eq(embeddings.refId, refId),
      eq(embeddings.variant, variant),
      eq(embeddings.modelVersion, TEXT_EMBED_MODEL_VERSION),
    ))
    .get()
  return !!row
}

export async function backfillItemTextEmbeddings(task: AiTask): Promise<number> {
  if (!isEnabled()) return 0
  let embedded = 0
  for (const item of db.select().from(items).all()) {
    if (alreadyEmbedded('item', item.id, 'main')) continue
    try {
      const blob = textItemSourceBlob(item)
      await runInstrumented<void>({
        userId: item.userId,
        task,
        provider: embedProvider(TEXT_EMBED_MODEL, 'gemini'),
        model: TEXT_EMBED_MODEL,
        expectedBilledTokens: 0,
        itemId: item.id,
        call: async () => {
          const vec = await embedText(blob)
          await saveEmbedding({
            level: 'item', refId: item.id, userId: item.userId, variant: 'main',
            modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: blob,
          })
          return { result: undefined as void, usage: { tokensIn: Math.ceil(blob.length / 4), tokensOut: 0 } }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:backfill] item ${item.id}:`, (err as Error).message)
    }
  }
  return embedded
}

export async function backfillOutfitTextEmbeddings(task: AiTask): Promise<number> {
  if (!isEnabled()) return 0
  let embedded = 0
  for (const outfit of db.select().from(outfits).all()) {
    if (alreadyEmbedded('outfit', outfit.id, 'metadata')) continue
    try {
      const blob = textOutfitSourceBlob(outfit)
      await runInstrumented<void>({
        userId: outfit.userId,
        task,
        provider: embedProvider(TEXT_EMBED_MODEL, 'gemini'),
        model: TEXT_EMBED_MODEL,
        expectedBilledTokens: 0,
        outfitId: outfit.id,
        call: async () => {
          const vec = await embedText(blob)
          await saveEmbedding({
            level: 'outfit', refId: outfit.id, userId: outfit.userId, variant: 'metadata',
            modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: blob,
          })
          return { result: undefined as void, usage: { tokensIn: Math.ceil(blob.length / 4), tokensOut: 0 } }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:backfill] outfit ${outfit.id}:`, (err as Error).message)
    }
  }
  return embedded
}

export async function backfillShareTextEmbeddings(task: AiTask): Promise<number> {
  if (!isEnabled()) return 0
  let embedded = 0
  for (const share of db.select().from(sharePayloads).all()) {
    if (alreadyEmbedded('share', share.id, 'main')) continue
    const description = share.description
    if (!description) continue
    try {
      await runInstrumented<void>({
        userId: share.userId,
        task,
        provider: embedProvider(TEXT_EMBED_MODEL, 'gemini'),
        model: TEXT_EMBED_MODEL,
        expectedBilledTokens: 0,
        call: async () => {
          const vec = await embedText(description)
          await saveEmbedding({
            level: 'share', refId: share.id, userId: share.userId, variant: 'main',
            modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: description,
          })
          return { result: undefined as void, usage: { tokensIn: Math.ceil(description.length / 4), tokensOut: 0 } }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:backfill] share ${share.id}:`, (err as Error).message)
    }
  }
  return embedded
}

// ─── Stale text re-embed (#376) ───────────────────────────────────────────────
//
// The backfills above only fill missing vectors. A row whose metadata changed
// without an inline re-embed (deleteFacetEverywhere, admin normalisations, a
// failed on-save embed) keeps a vector of its old text. Such a row has
// updated_at newer than its vector's created_at (saveEmbedding stamps that on
// every upsert), so it is found here and re-embedded. A normal PATCH re-embeds
// right after bumping updated_at, so its vector is already newer and skipped.

/** Model calls per user per run. Rows whose text did not change cost nothing and are not counted. */
export const STALE_REEMBED_PER_USER_LIMIT = 50
/** Model calls per run, across all users. */
export const STALE_REEMBED_TOTAL_LIMIT = 500

export interface StaleReembedResult {
  /** Items / outfits re-embedded. */
  items: number
  outfits: number
  /** Rows whose text was unchanged: vector re-stamped, no model call. */
  unchanged: number
}

type StaleItem = { row: typeof items.$inferSelect; embeddingId: string; sourceBlob: string; embeddedAt: number }
type StaleOutfit = { row: typeof outfits.$inferSelect; embeddingId: string; sourceBlob: string; embeddedAt: number }

/** One user's items whose current text vector is older than the item's last change, oldest change first. */
export function listStaleItemTextEmbeddings(userId: string): StaleItem[] {
  requireUserId(userId)
  return db.select({ row: items, embeddingId: embeddings.id, sourceBlob: embeddings.sourceBlob, embeddedAt: embeddings.createdAt })
    .from(items)
    .innerJoin(embeddings, and(
      eq(embeddings.level, 'item'),
      eq(embeddings.refId, items.id),
      eq(embeddings.userId, items.userId),
      eq(embeddings.variant, 'main'),
      eq(embeddings.modelVersion, TEXT_EMBED_MODEL_VERSION),
    ))
    .where(and(eq(items.userId, userId), gt(items.updatedAt, embeddings.createdAt)))
    .orderBy(asc(items.updatedAt))
    .all()
}

/** One user's outfits whose current text vector is older than the outfit's last change, oldest change first. */
export function listStaleOutfitTextEmbeddings(userId: string): StaleOutfit[] {
  requireUserId(userId)
  return db.select({ row: outfits, embeddingId: embeddings.id, sourceBlob: embeddings.sourceBlob, embeddedAt: embeddings.createdAt })
    .from(outfits)
    .innerJoin(embeddings, and(
      eq(embeddings.level, 'outfit'),
      eq(embeddings.refId, outfits.id),
      eq(embeddings.userId, outfits.userId),
      eq(embeddings.variant, OUTFIT_TEXT_VARIANT),
      eq(embeddings.modelVersion, TEXT_EMBED_MODEL_VERSION),
    ))
    .where(and(eq(outfits.userId, userId), gt(outfits.updatedAt, embeddings.createdAt)))
    .orderBy(asc(outfits.updatedAt))
    .all()
}

// Stamp the vector with the row's change time it was checked against, not
// "now": an edit landing after the read still leaves the row newer.
function markEmbeddingCurrent(embeddingId: string, userId: string, asOf: number): void {
  db.update(embeddings).set({ createdAt: asOf })
    .where(and(eq(embeddings.id, embeddingId), eq(embeddings.userId, userId)))
    .run()
}

function currentItemBlob(id: string, userId: string): string | null {
  const row = db.select().from(items).where(and(eq(items.id, id), eq(items.userId, userId))).get()
  return row ? textItemSourceBlob(row) : null
}

function currentOutfitBlob(id: string, userId: string): string | null {
  const row = db.select().from(outfits).where(and(eq(outfits.id, id), eq(outfits.userId, userId))).get()
  return row ? textOutfitSourceBlob(row) : null
}

async function reembedStale(opts: {
  task: AiTask
  userId: string
  level: 'item' | 'outfit'
  refId: string
  variant: EmbedVariant
  blob: string
  currentBlob: () => string | null
}): Promise<boolean> {
  const { task, userId, level, refId, variant, blob } = opts
  return runInstrumented<boolean>({
    userId,
    task,
    provider: embedProvider(TEXT_EMBED_MODEL, 'gemini'),
    model: TEXT_EMBED_MODEL,
    expectedBilledTokens: 0,
    ...(level === 'item' ? { itemId: refId } : { outfitId: refId }),
    call: async () => {
      const vec = await embedText(blob)
      // Edited (or deleted) while embedding: its own on-save embed or the
      // next run covers it. Saving now would stamp stale text as current.
      const saved = opts.currentBlob() === blob
      if (saved) {
        await saveEmbedding({ level, refId, userId, variant, modelVersion: TEXT_EMBED_MODEL_VERSION, vector: vec, sourceBlob: blob })
      }
      return { result: saved, usage: { tokensIn: Math.ceil(blob.length / 4), tokensOut: 0 } }
    },
  })
}

/** Distinct owners of items or outfits, in a stable order. */
function usersWithRows(): string[] {
  const ids = new Set<string>()
  for (const r of db.selectDistinct({ userId: items.userId }).from(items).all()) ids.add(r.userId)
  for (const r of db.selectDistinct({ userId: outfits.userId }).from(outfits).all()) ids.add(r.userId)
  return [...ids].sort()
}

/**
 * Re-embeds items and outfits whose metadata changed after their text vector
 * was written. One user at a time, never mixing tenants: each user's rows are
 * read, embedded and written under that user. Model calls are capped per user
 * and per run; what is left over is picked up next run (oldest change first).
 */
export async function reembedStaleTextEmbeddings(
  task: AiTask,
  limits: { perUser?: number; total?: number } = {},
): Promise<StaleReembedResult> {
  const result: StaleReembedResult = { items: 0, outfits: 0, unchanged: 0 }
  if (!isEnabled()) return result
  const perUser = limits.perUser ?? STALE_REEMBED_PER_USER_LIMIT
  let totalLeft = limits.total ?? STALE_REEMBED_TOTAL_LIMIT

  for (const userId of usersWithRows()) {
    if (totalLeft <= 0) break
    let userLeft = perUser

    const candidates = [
      ...listStaleItemTextEmbeddings(userId).map(c => ({
        level: 'item' as const, variant: 'main' as EmbedVariant, refId: c.row.id, updatedAt: c.row.updatedAt,
        blob: textItemSourceBlob(c.row), c, currentBlob: () => currentItemBlob(c.row.id, userId),
      })),
      ...listStaleOutfitTextEmbeddings(userId).map(c => ({
        level: 'outfit' as const, variant: OUTFIT_TEXT_VARIANT, refId: c.row.id, updatedAt: c.row.updatedAt,
        blob: textOutfitSourceBlob(c.row), c, currentBlob: () => currentOutfitBlob(c.row.id, userId),
      })),
    ].sort((a, b) => a.updatedAt - b.updatedAt)

    for (const cand of candidates) {
      if (cand.blob === cand.c.sourceBlob) {
        // e.g. marked worn, cover photo changed: text the vector was built from is unchanged.
        markEmbeddingCurrent(cand.c.embeddingId, userId, cand.updatedAt)
        result.unchanged++
        continue
      }
      if (userLeft <= 0 || totalLeft <= 0) continue
      userLeft--
      totalLeft--
      try {
        const saved = await reembedStale({
          task, userId, level: cand.level, refId: cand.refId, variant: cand.variant,
          blob: cand.blob, currentBlob: cand.currentBlob,
        })
        if (saved) result[cand.level === 'item' ? 'items' : 'outfits']++
      } catch (err) {
        console.warn(`[embed:stale] ${cand.level} ${cand.refId}:`, (err as Error).message)
      }
    }
  }
  return result
}

// ─── Image backfill ───────────────────────────────────────────────────────────

function isImageEnabled(): boolean {
  return process.env.IMAGE_EMBED_ENABLED === 'true' || process.env.IMAGE_EMBED_ENABLED === '1'
}

function alreadyImageEmbedded(level: 'item' | 'outfit' | 'share', refId: string, variant: 'image' | 'image_cover' | 'image_snapshot'): boolean {
  const row = db.select({ id: embeddings.id })
    .from(embeddings)
    .where(and(
      eq(embeddings.level, level),
      eq(embeddings.refId, refId),
      eq(embeddings.variant, variant),
      eq(embeddings.modelVersion, IMAGE_EMBED_MODEL_VERSION),
    ))
    .get()
  return !!row
}

export async function backfillItemImageEmbeddings(task: AiTask): Promise<number> {
  if (!isImageEnabled()) return 0
  let embedded = 0
  for (const item of db.select().from(items).all()) {
    if (alreadyImageEmbedded('item', item.id, 'image')) continue
    try {
      await runInstrumented<void>({
        userId: item.userId,
        task,
        provider: embedProvider(IMAGE_EMBED_MODEL, 'vertex'),
        model: IMAGE_EMBED_MODEL,
        expectedBilledTokens: 0,
        itemId: item.id,
        call: async () => {
          const vec = await embedItemImage(item.imageUri, item.userId)
          await saveEmbedding({
            level: 'item', refId: item.id, userId: item.userId, variant: 'image',
            modelVersion: IMAGE_EMBED_MODEL_VERSION, vector: vec, sourceBlob: item.imageUri,
          })
          return { result: undefined as void, usage: {} }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:image-backfill] item ${item.id}:`, (err as Error).message)
    }
  }
  return embedded
}

export async function backfillOutfitImageEmbeddings(task: AiTask): Promise<number> {
  if (!isImageEnabled()) return 0
  let embedded = 0
  for (const outfit of db.select().from(outfits).all()) {
    if (!outfit.coverImageUri) continue
    const coverImageUri = outfit.coverImageUri
    if (alreadyImageEmbedded('outfit', outfit.id, 'image_cover')) continue
    try {
      await runInstrumented<void>({
        userId: outfit.userId,
        task,
        provider: embedProvider(IMAGE_EMBED_MODEL, 'vertex'),
        model: IMAGE_EMBED_MODEL,
        expectedBilledTokens: 0,
        outfitId: outfit.id,
        call: async () => {
          const vec = await embedItemImage(coverImageUri, outfit.userId)
          await saveEmbedding({
            level: 'outfit', refId: outfit.id, userId: outfit.userId, variant: 'image_cover',
            modelVersion: IMAGE_EMBED_MODEL_VERSION, vector: vec, sourceBlob: coverImageUri,
          })
          return { result: undefined as void, usage: {} }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:image-backfill] outfit ${outfit.id}:`, (err as Error).message)
    }
  }
  return embedded
}

export async function backfillShareImageEmbeddings(task: AiTask): Promise<number> {
  if (!isImageEnabled()) return 0
  let embedded = 0
  for (const share of db.select().from(sharePayloads).all()) {
    if (alreadyImageEmbedded('share', share.id, 'image_snapshot')) continue
    const uris: string[] = (() => {
      try { return JSON.parse(share.imageUris ?? '[]') as string[] }
      catch { return [] }
    })()
    const firstUri = uris[0]
    if (!firstUri) continue
    try {
      await runInstrumented<void>({
        userId: share.userId,
        task,
        provider: embedProvider(IMAGE_EMBED_MODEL, 'vertex'),
        model: IMAGE_EMBED_MODEL,
        expectedBilledTokens: 0,
        call: async () => {
          const vec = await embedItemImage(firstUri, share.userId)
          await saveEmbedding({
            level: 'share', refId: share.id, userId: share.userId, variant: 'image_snapshot',
            modelVersion: IMAGE_EMBED_MODEL_VERSION, vector: vec, sourceBlob: firstUri,
          })
          return { result: undefined as void, usage: {} }
        },
      })
      embedded++
    } catch (err) {
      console.warn(`[embed:image-backfill] share ${share.id}:`, (err as Error).message)
    }
  }
  return embedded
}
