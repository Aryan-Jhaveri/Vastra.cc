import { getAllEmbeddings, reciprocalRankFusion, topKText, topKTextWithScores } from '../storage/embeddings.js'
import { embedText, OUTFIT_TEXT_VARIANT } from './embed.js'

// Discover's retrieval layer: embedding pre-filter over the user's items and
// the non-LLM related-outfit signals (embedding match, item-seeded overlap,
// RRF fusion, recency padding). No generation and no ranking model here — the
// Discover route layers Jev + the LLM on top; the agent `discover_closet` tool
// uses this alone.
//
// Cost: the only model call is the query text embedding (gemini-embedding-001,
// via getOrEmbedQuery). It is cached per (userId, text), never billed to the
// wallet and not written to ai_calls. With MOCK_EMBEDDINGS it's a local hash.
//
// Every read is keyed on userId (embeddings + the query cache are per user).

export const PRE_FILTER_K = 12
/** Wider prefilter for user-typed queries (weak short-query embeddings). */
export const PRE_FILTER_K_PROMPT = 30
export const SHORTLIST_POOL_K = 40
export const OUTFIT_POOL_K = 16
/** Cosine gate: below this, short queries surface centroid-adjacent noise. */
export const RELATED_MIN_SIMILARITY = 0.30

/**
 * Top `k` item ids for `contextText` by text embedding, skipping `exclude`.
 * Searches `k + exclude.length` so exclusions don't shrink the result.
 */
export async function textItemShortlist(contextText: string, userId: string, k: number, exclude: string[] = []): Promise<string[]> {
  const topIds = await topKText(contextText, embedText, userId, 'item', 'main', k + exclude.length)
  return topIds.filter(id => !exclude.includes(id)).slice(0, k)
}

/** Saved outfits whose text vector clears RELATED_MIN_SIMILARITY, best first. */
export async function embeddingOutfitIds(
  contextText: string, userId: string, exclude: string[] = [], k = OUTFIT_POOL_K,
): Promise<string[]> {
  const outfitEmbeds = getAllEmbeddings(userId, 'outfit', OUTFIT_TEXT_VARIANT)
  if (outfitEmbeds.size === 0) return []
  const ex = new Set(exclude)
  const scored = await topKTextWithScores(contextText, embedText, userId, 'outfit', OUTFIT_TEXT_VARIANT, k + exclude.length)
  return scored
    .filter(s => s.score >= RELATED_MIN_SIMILARITY && !ex.has(s.id))
    .slice(0, k)
    .map(s => s.id)
}

interface OutfitRow { id: string; itemIds: string; createdAt: number }

/**
 * Outfits intersecting the seed items. Score = mean reciprocal rank of the
 * outfit's items in the seed order (items outside the seed count 0). Raw hit
 * counts favoured the biggest outfits (#330).
 */
export function itemSeededOutfitIds(
  savedOutfits: OutfitRow[], seedItemIds: string[], exclude: Set<string>, k = OUTFIT_POOL_K,
): string[] {
  const seedRank = new Map(seedItemIds.map((id, idx) => [id, idx]))
  return savedOutfits
    .filter(o => !exclude.has(o.id))
    .map(o => {
      const ids: string[] = JSON.parse(o.itemIds)
      let sum = 0
      for (const id of ids) {
        const r = seedRank.get(id)
        if (r !== undefined) sum += 1 / (r + 1)
      }
      return { id: o.id, score: ids.length ? sum / ids.length : 0 }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.id)
}

/**
 * RRF over two ranked id lists, then recency padding. Recency only PADS
 * existing signal results — never standalone, so an unrelated query doesn't
 * get "the same 4 recent outfits".
 */
export function fuseOutfitSignals(
  signal1Ids: string[], signal2Ids: string[], savedOutfits: OutfitRow[], exclude: Set<string>, k = OUTFIT_POOL_K,
): string[] {
  const toRanks = (ids: string[]) => {
    const m = new Map<string, number>()
    ids.forEach((id, i) => m.set(id, i))
    return m
  }
  const fusedIds = [...reciprocalRankFusion(toRanks(signal1Ids), toRanks(signal2Ids), k).keys()]
  const fusedSet = new Set(fusedIds)
  if (fusedIds.length > 0 && fusedIds.length < k) {
    const recents = savedOutfits
      .filter(o => !exclude.has(o.id) && !fusedSet.has(o.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, k - fusedIds.length)
    for (const rec of recents) fusedIds.push(rec.id)
  }
  return fusedIds
}
