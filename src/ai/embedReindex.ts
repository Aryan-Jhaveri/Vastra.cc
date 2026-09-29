// #353 — switching embedding model or dimension (e.g. Vertex → Qwen3-VL-
// Embedding) changes every row's model version. Reads already ignore rows from
// the old model (modelVersionForVariant), so the switch is safe the moment it
// happens; this module fills the new vectors in and clears the old ones.
//
// - status(): per level, how many rows carry the current version out of how
//   many need one, plus how many superseded rows remain. Counts only: no
//   vectors, text or user ids leave the table.
// - startReembed(): one background pass over the existing backfill functions.
//   They skip anything already embedded at the current version, so a pass is
//   resumable: stop the server halfway and the next pass carries on. Outfit
//   image centroids are rebuilt after the image pass.
// - pruneSuperseded(): delete old-version rows, refused while a pass runs or
//   before coverage is complete (unless forced), so retrieval never loses
//   vectors it could still have used.
//
// Instance-wide and admin-only (mounted behind requireAdmin).

import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { embeddings, items, outfits, sharePayloads } from '../db/schema.js'
import {
  IMAGE_EMBED_MODEL_VERSION, IMAGE_VARIANTS, TEXT_EMBED_MODEL_VERSION, type EmbedLevel, type EmbedVariant,
} from '../storage/embeddings.js'
import {
  backfillItemImageEmbeddings, backfillItemTextEmbeddings, backfillOutfitImageEmbeddings, backfillOutfitTextEmbeddings,
  backfillShareImageEmbeddings, backfillShareTextEmbeddings,
} from './embedBackfill.js'
import { embedOutfitCentroidOnSave } from './embedImage.js'

const IMAGE_VARIANT_LIST = [...IMAGE_VARIANTS] as string[]

function enabled(flag: string): boolean {
  return process.env[flag] === 'true' || process.env[flag] === '1'
}

export interface Coverage { total: number; current: number }

function currentCount(level: EmbedLevel, variant: EmbedVariant, version: string): number {
  const row = db.select({ n: sql<number>`count(distinct ${embeddings.refId})` })
    .from(embeddings)
    .where(and(eq(embeddings.level, level), eq(embeddings.variant, variant), eq(embeddings.modelVersion, version)))
    .get()
  return Number(row?.n ?? 0)
}

function count(query: { n: number } | undefined): number {
  return Number(query?.n ?? 0)
}

function supersededCount(kind: 'text' | 'image'): number {
  const where = kind === 'image'
    ? and(inArray(embeddings.variant, IMAGE_VARIANT_LIST), ne(embeddings.modelVersion, IMAGE_EMBED_MODEL_VERSION))
    : and(notInArray(embeddings.variant, IMAGE_VARIANT_LIST), ne(embeddings.modelVersion, TEXT_EMBED_MODEL_VERSION))
  return count(db.select({ n: sql<number>`count(*)` }).from(embeddings).where(where).get())
}

export interface EmbeddingStatus {
  text: { enabled: boolean; modelVersion: string; items: Coverage; outfits: Coverage; shares: Coverage; superseded: number }
  image: { enabled: boolean; modelVersion: string; items: Coverage; outfits: Coverage; shares: Coverage; superseded: number }
  job: JobState
}

export interface JobState {
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  /** Vectors written by the last (or current) pass. */
  embedded: number
  error: string | null
}

let job: JobState = { running: false, startedAt: null, finishedAt: null, embedded: 0, error: null }

export function embeddingStatus(): EmbeddingStatus {
  const itemTotal = count(db.select({ n: sql<number>`count(*)` }).from(items).get())
  const outfitTotal = count(db.select({ n: sql<number>`count(*)` }).from(outfits).get())
  const coveredOutfits = count(db.select({ n: sql<number>`count(*)` }).from(outfits).where(sql`${outfits.coverImageUri} is not null and ${outfits.coverImageUri} != ''`).get())
  const describedShares = count(db.select({ n: sql<number>`count(*)` }).from(sharePayloads).where(sql`${sharePayloads.description} is not null and ${sharePayloads.description} != ''`).get())
  const imageShares = count(db.select({ n: sql<number>`count(*)` }).from(sharePayloads).where(sql`${sharePayloads.imageUris} is not null and ${sharePayloads.imageUris} not in ('', '[]')`).get())
  return {
    text: {
      enabled: enabled('TEXT_EMBED_ENABLED'),
      modelVersion: TEXT_EMBED_MODEL_VERSION,
      items: { total: itemTotal, current: currentCount('item', 'main', TEXT_EMBED_MODEL_VERSION) },
      outfits: { total: outfitTotal, current: currentCount('outfit', 'metadata', TEXT_EMBED_MODEL_VERSION) },
      shares: { total: describedShares, current: currentCount('share', 'main', TEXT_EMBED_MODEL_VERSION) },
      superseded: supersededCount('text'),
    },
    image: {
      enabled: enabled('IMAGE_EMBED_ENABLED'),
      modelVersion: IMAGE_EMBED_MODEL_VERSION,
      items: { total: itemTotal, current: currentCount('item', 'image', IMAGE_EMBED_MODEL_VERSION) },
      outfits: { total: coveredOutfits, current: currentCount('outfit', 'image_cover', IMAGE_EMBED_MODEL_VERSION) },
      shares: { total: imageShares, current: currentCount('share', 'image_snapshot', IMAGE_EMBED_MODEL_VERSION) },
      superseded: supersededCount('image'),
    },
    job: { ...job },
  }
}

function coverageComplete(status: EmbeddingStatus): boolean {
  const done = (c: Coverage) => c.current >= c.total
  const kinds = [status.text, status.image].filter(k => k.enabled)
  return kinds.every(k => done(k.items) && done(k.outfits) && done(k.shares))
}

/** Start a background pass. Returns false if one is already running. */
export function startReembed(): boolean {
  if (job.running) return false
  job = { running: true, startedAt: Date.now(), finishedAt: null, embedded: 0, error: null }
  void (async () => {
    try {
      for (const pass of [
        backfillItemTextEmbeddings, backfillOutfitTextEmbeddings, backfillShareTextEmbeddings,
        backfillItemImageEmbeddings, backfillOutfitImageEmbeddings, backfillShareImageEmbeddings,
      ]) {
        job.embedded += await pass('embed_reconcile')
      }
      if (enabled('IMAGE_EMBED_ENABLED')) {
        // Centroids are means of item image vectors, so rebuild them from the
        // current model's vectors (old ones are filtered out on read).
        for (const outfit of db.select({ id: outfits.id, itemIds: outfits.itemIds, userId: outfits.userId }).from(outfits).all()) {
          await embedOutfitCentroidOnSave(outfit, outfit.userId)
        }
      }
    } catch (err) {
      job.error = (err as Error).message
    } finally {
      job.running = false
      job.finishedAt = Date.now()
    }
  })()
  return true
}

export type PruneResult = { ok: true; deleted: number } | { ok: false; reason: 'running' | 'incomplete' }

export function pruneSuperseded({ force = false } = {}): PruneResult {
  if (job.running) return { ok: false, reason: 'running' }
  if (!force && !coverageComplete(embeddingStatus())) return { ok: false, reason: 'incomplete' }
  const text = db.delete(embeddings)
    .where(and(notInArray(embeddings.variant, IMAGE_VARIANT_LIST), ne(embeddings.modelVersion, TEXT_EMBED_MODEL_VERSION)))
    .run()
  const image = db.delete(embeddings)
    .where(and(inArray(embeddings.variant, IMAGE_VARIANT_LIST), ne(embeddings.modelVersion, IMAGE_EMBED_MODEL_VERSION)))
    .run()
  return { ok: true, deleted: text.changes + image.changes }
}

/** Test-only. */
export function __resetReembedJob(): void {
  job = { running: false, startedAt: null, finishedAt: null, embedded: 0, error: null }
}
